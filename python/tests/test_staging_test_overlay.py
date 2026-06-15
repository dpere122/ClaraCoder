"""Tests for ephemeral staging overlay (pre-transfer command runs)."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from nemo_backend.deferred_tool_hitl import deferred_tool_hitl_bypass
from nemo_backend.domain import EditStagingEntry
from nemo_backend import staging_test_overlay as sto
from nemo_backend.agents.specialists.review_tools import run_staging_overlay_command
from nemo_backend.state import current_session_id, get_session, runtime_config
from nemo_backend.domain import RuntimeToolsConfig


def test_parse_command_argv_json() -> None:
    ok, err = sto.parse_command_argv_json(json.dumps(['a', 'b']))
    assert ok == ['a', 'b'] and err == ''
    bad, err2 = sto.parse_command_argv_json('not json')
    assert bad is None and 'not valid JSON' in err2


def test_validate_overlay_command_argv_allows_pytest() -> None:
    ok, err = sto.validate_overlay_command_argv(['pytest', 'tests', '-v'])
    assert ok == ['pytest', 'tests', '-v'] and err == ''


def test_validate_overlay_command_argv_allows_python_m_pytest() -> None:
    ok, err = sto.validate_overlay_command_argv([sys.executable, '-m', 'pytest', 'tests'])
    assert ok is not None and err == ''


def test_validate_overlay_command_argv_allows_relative_script() -> None:
    ok, err = sto.validate_overlay_command_argv([sys.executable, 'scripts/check.py'])
    assert ok is not None and err == ''


def test_validate_overlay_command_argv_blocks_python_c() -> None:
    ok, err = sto.validate_overlay_command_argv([sys.executable, '-c', 'print(1)'])
    assert ok is None and 'inline code' in err.lower()


def test_validate_overlay_command_argv_blocks_shell() -> None:
    ok, err = sto.validate_overlay_command_argv(['powershell', '-Command', 'Get-ChildItem'])
    assert ok is None and 'shell' in err.lower()


def test_validate_overlay_command_argv_blocks_npm_install() -> None:
    ok, err = sto.validate_overlay_command_argv(['npm', 'install', 'left-pad'])
    assert ok is None and 'mutates dependencies' in err


def test_validate_overlay_command_argv_allows_npx_vite() -> None:
    ok, err = sto.validate_overlay_command_argv(['npx', 'vite'])
    assert ok == ['npx', 'vite'] and err == ''


def test_validate_overlay_command_argv_blocks_unknown_npx_tool() -> None:
    ok, err = sto.validate_overlay_command_argv(['npx', 'some-random-pkg'])
    assert ok is None and 'npx' in err.lower()


def test_resolve_overlay_cwd(tmp_path: Path) -> None:
    root = tmp_path / 'w'
    root.mkdir()
    cwd, err = sto.resolve_overlay_cwd(root, '')
    assert err == '' and cwd == root.resolve()
    sub, err2 = sto.resolve_overlay_cwd(root, 'a/b')
    assert err2 == '' and sub == (root / 'a' / 'b').resolve()
    bad, err3 = sto.resolve_overlay_cwd(root, '..')
    assert bad is None and '..' in err3


def test_build_overlay_applies_staged_text(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sto, 'get_staging_root', lambda: tmp_path / 'stg_root')
    ws = tmp_path / 'ws'
    ws.mkdir()
    (ws / 'pkg').mkdir(parents=True)
    (ws / 'pkg' / 'mod.txt').write_text('disk', encoding='utf-8')

    session_id = 'overlay-test-sid'
    session = get_session(session_id)
    session.workspace_path = str(ws.resolve())
    draft = tmp_path / 'draft.bin'
    draft.write_bytes(b'x')
    session.pending_edit_stagings['pkg/mod.txt'] = EditStagingEntry(
        temp_path=str(draft),
        old_text='disk',
        merged_text='STAGED',
        disk_encoding='utf-8',
        disk_newline='lf',
        edit_mode='full-file',
    )

    overlay_root, overlay_parent, err = sto.build_staging_test_overlay(session, ws, session_id)
    assert err == '' and overlay_root is not None and overlay_parent is not None
    try:
        assert (ws / 'pkg' / 'mod.txt').read_text(encoding='utf-8') == 'disk'
        assert (overlay_root / 'pkg' / 'mod.txt').read_text(encoding='utf-8') == 'STAGED'
    finally:
        sto.remove_overlay_parent(overlay_parent)


@pytest.mark.asyncio
async def test_run_staging_overlay_command_respects_disable_flag(tmp_path: Path) -> None:
    saved = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(allow_staging_overlay_commands=False)
    token = current_session_id.set('overlay-dis')
    try:
        ws = tmp_path / 'ws2'
        ws.mkdir()
        session = get_session('overlay-dis')
        session.workspace_path = str(ws.resolve())
        session.worker_apply_mode = True
        out = await run_staging_overlay_command.ainvoke(
            {'command_argv_json': json.dumps([sys.executable, '-m', 'pytest', '--version']), 'cwd_relative': ''}
        )
        assert 'disabled' in out.lower()
    finally:
        current_session_id.reset(token)
        runtime_config.tools = saved


@pytest.mark.asyncio
async def test_run_staging_overlay_command_runs_in_overlay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sto, 'get_staging_root', lambda: tmp_path / 'stg_root2')
    saved = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(allow_staging_overlay_commands=True)
    session_id = 'overlay-run-sid'
    token = current_session_id.set(session_id)
    try:
        ws = tmp_path / 'ws3'
        ws.mkdir()
        (ws / 'touched.txt').write_text('orig', encoding='utf-8')
        session = get_session(session_id)
        session.workspace_path = str(ws.resolve())
        session.worker_apply_mode = True
        session.auto_apply_mode = False
        session.abort_event.clear()
        (ws / 'read_touched.py').write_text(
            "from pathlib import Path\nprint(Path('touched.txt').read_text(encoding='utf-8').strip())\n",
            encoding='utf-8',
        )
        draft = tmp_path / 'd2.txt'
        draft.write_text('z', encoding='utf-8')
        session.pending_edit_stagings['touched.txt'] = EditStagingEntry(
            temp_path=str(draft),
            old_text='orig',
            merged_text='from_staging',
            disk_encoding='utf-8',
            disk_newline='lf',
            edit_mode='full-file',
        )
        argv_json = json.dumps([sys.executable, 'read_touched.py'])
        hitl_token = deferred_tool_hitl_bypass.set(True)
        try:
            out = await run_staging_overlay_command.ainvoke({'command_argv_json': argv_json, 'cwd_relative': ''})
        finally:
            deferred_tool_hitl_bypass.reset(hitl_token)
        assert 'from_staging' in out
        assert (ws / 'touched.txt').read_text(encoding='utf-8') == 'orig'
    finally:
        current_session_id.reset(token)
        runtime_config.tools = saved


@pytest.mark.asyncio
async def test_run_staging_overlay_command_runs_in_workspace_when_direct(tmp_path: Path) -> None:
    saved = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(allow_staging_overlay_commands=True)
    session_id = 'overlay-direct-sid'
    token = current_session_id.set(session_id)
    try:
        ws = tmp_path / 'ws-direct'
        ws.mkdir()
        (ws / 'read_on_disk.py').write_text(
            "from pathlib import Path\nprint(Path('on_disk.txt').read_text(encoding='utf-8').strip())\n",
            encoding='utf-8',
        )
        marker = ws / 'on_disk.txt'
        marker.write_text('workspace_body', encoding='utf-8')
        session = get_session(session_id)
        session.workspace_path = str(ws.resolve())
        session.worker_apply_mode = True
        session.auto_apply_mode = True
        session.abort_event.clear()
        argv_json = json.dumps([sys.executable, 'read_on_disk.py'])
        out = await run_staging_overlay_command.ainvoke({'command_argv_json': argv_json, 'cwd_relative': ''})
        assert 'workspace_body' in out
        assert 'Working directory (workspace)' in out
    finally:
        current_session_id.reset(token)
        runtime_config.tools = saved


@pytest.mark.asyncio
async def test_run_staging_overlay_command_watch_mode_stops_on_readiness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    saved = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(allow_staging_overlay_commands=True)
    session_id = 'overlay-watch-sid'
    token = current_session_id.set(session_id)
    try:
        ws = tmp_path / 'ws-watch'
        ws.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(ws.resolve())
        session.worker_apply_mode = True
        session.auto_apply_mode = True
        session.abort_event.clear()
        session.planning_nested_events_q = asyncio.Queue()

        class _WatchProc:
            def __init__(self) -> None:
                self.stdout = _FakeAsyncStreamReader(
                    b'\n  VITE v5.0.0  ready in 120 ms\n  \xe2\x9e\x9c  Local:   http://localhost:5173/\n'
                )
                self.stderr = _FakeAsyncStreamReader(b'')
                self.returncode: int | None = None
                self.terminated = False

            async def wait(self) -> int:
                await asyncio.sleep(30)
                self.returncode = self.returncode if self.returncode is not None else 0
                return self.returncode

            def terminate(self) -> None:
                self.terminated = True
                self.returncode = -15

            def kill(self) -> None:
                self.returncode = -9

        fake_proc = _WatchProc()

        async def _fake_create_subprocess_exec(*_args, **_kwargs):
            return fake_proc

        monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

        argv_json = json.dumps(['npx', 'vite'])
        out = await run_staging_overlay_command.ainvoke({'command_argv_json': argv_json, 'cwd_relative': ''})
        assert 'dev server readiness detected' in out
        assert fake_proc.terminated is True
        complete_events = []
        while not session.planning_nested_events_q.empty():
            item = await session.planning_nested_events_q.get()
            if item[1].get('event') == 'tool_exec_complete':
                complete_events.append(item)
        assert complete_events
        payload = complete_events[-1][1].get('data') or {}
        assert payload.get('outcome') == 'passed'
    finally:
        current_session_id.reset(token)
        runtime_config.tools = saved


class _FakeAsyncStreamReader:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    async def read(self, n: int = -1) -> bytes:
        await asyncio.sleep(0)
        if self._pos >= len(self._data):
            return b''
        if n == -1:
            chunk = self._data[self._pos :]
            self._pos = len(self._data)
            return chunk
        chunk = self._data[self._pos : self._pos + n]
        self._pos += len(chunk)
        return chunk
