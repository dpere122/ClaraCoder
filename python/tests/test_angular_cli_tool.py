"""Tests for :mod:`nemo_backend.angular_cli_tool`."""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

import pytest

from nemo_backend.accept_command import accept_command_sse_payload, execute_pending_accept_command_decision
from nemo_backend.angular_cli_tool import (
    angular_cli_tool,
    resolve_local_ng_executable,
    validate_ng_args,
)
from nemo_backend.state import current_session_id, get_session


class _FakeProc:
    def __init__(self, *, output: bytes = b'', returncode: int = 0) -> None:
        self.stdout = None
        self.stderr = None
        self.returncode = returncode
        self._output = output

    async def communicate(self) -> tuple[bytes, bytes]:
        await asyncio.sleep(0)
        return self._output, b''


def _fake_ng_bin_name() -> str:
    return 'ng.cmd' if sys.platform.startswith('win') else 'ng'


@pytest.fixture()
def angular_env():
    td = tempfile.TemporaryDirectory()
    project_root = Path(td.name)
    (project_root / 'package.json').write_text('{"name":"t"}', encoding='utf-8')
    bindir = project_root / 'node_modules' / '.bin'
    bindir.mkdir(parents=True)
    ng_name = _fake_ng_bin_name()
    (bindir / ng_name).write_text('', encoding='utf-8')

    session_id = 'test-angular-cli-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(project_root.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    session.pending_accept_command_request = None

    class _Env:
        pass

    env = _Env()
    env.project_root = project_root  # type: ignore[attr-defined]
    env.ng_bin = bindir / ng_name  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]

    yield env

    current_session_id.reset(token)
    td.cleanup()


@pytest.mark.parametrize(
    ('ng_args', 'expect_err_fragment'),
    [
        ([], 'non-empty'),
        ({}, 'must be a list'),
        ([''], 'empty'),
        (['../x'], '`..`'),
        (['a;b'], 'disallowed'),
        (['bad space'], 'unsupported'),
    ],
)
def test_validate_ng_args_rejects_invalid(ng_args, expect_err_fragment: str) -> None:
    out, err = validate_ng_args(ng_args)
    assert out is None
    assert err is not None
    assert expect_err_fragment in err


def test_validate_ng_args_accepts_build_flags() -> None:
    out, err = validate_ng_args(['build', '--configuration=production'])
    assert err is None
    assert out == ['build', '--configuration=production']


def test_resolve_local_ng_only_under_node_modules(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text('{}', encoding='utf-8')
    assert resolve_local_ng_executable(tmp_path) is None
    bindir = tmp_path / 'node_modules' / '.bin'
    bindir.mkdir(parents=True)
    ng_name = _fake_ng_bin_name()
    (bindir / ng_name).write_text('', encoding='utf-8')
    resolved = resolve_local_ng_executable(tmp_path)
    assert resolved is not None
    assert 'node_modules' in str(resolved).replace('\\', '/')
    assert '.bin' in str(resolved).replace('\\', '/')


@pytest.mark.asyncio
async def test_angular_cli_tool_errors_without_local_ng(tmp_path: Path) -> None:
    (tmp_path / 'package.json').write_text('{}', encoding='utf-8')
    sid = 'test-angular-no-ng'
    token = current_session_id.set(sid)
    session = get_session(sid)
    session.workspace_path = str(tmp_path.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    try:
        result = await angular_cli_tool.ainvoke({'ng_args': ['version']})
        assert 'local Angular CLI not found' in result
        assert 'npm_install_project' in result
    finally:
        current_session_id.reset(token)


@pytest.mark.asyncio
async def test_angular_cli_tool_auto_apply_runs_local_ng(angular_env, monkeypatch: pytest.MonkeyPatch) -> None:
    session = angular_env.session
    project_root = angular_env.project_root
    ng_bin = angular_env.ng_bin
    commands: list[tuple[str, ...]] = []

    async def _fake_create_subprocess_exec(*args, **kwargs):
        commands.append(tuple(str(a) for a in args))
        assert kwargs['cwd'] == str(project_root)
        return _FakeProc(output=b'Angular CLI: 19\n')

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    result = await angular_cli_tool.ainvoke({'ng_args': ['version']})

    assert 'Angular CLI summary' in result
    assert 'Angular CLI: 19' in result
    assert len(commands) == 1
    assert commands[0][0] == str(ng_bin.resolve())
    assert commands[0][1:] == ('version',)


@pytest.mark.asyncio
async def test_angular_cli_tool_stages_accept_command_when_auto_apply_off(angular_env) -> None:
    session = angular_env.session
    session.auto_apply_mode = False

    result = await angular_cli_tool.ainvoke({'ng_args': ['version']})

    assert 'Pending user confirmation' in result
    pending = session.pending_accept_command_request
    assert pending is not None
    payload = accept_command_sse_payload(pending)
    assert payload['kind'] == 'angular_cli'
    assert 'version' in payload['commandText']


@pytest.mark.asyncio
async def test_accept_command_confirmation_runs_angular_cli(angular_env, monkeypatch: pytest.MonkeyPatch) -> None:
    session = angular_env.session
    session.auto_apply_mode = False
    project_root = angular_env.project_root
    ng_bin = angular_env.ng_bin
    commands: list[tuple[str, ...]] = []

    async def _fake_create_subprocess_exec(*args, **kwargs):
        commands.append(tuple(str(a) for a in args))
        assert kwargs['cwd'] == str(project_root)
        return _FakeProc(output=b'done\n')

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    await angular_cli_tool.ainvoke({'ng_args': ['build']})
    pending = session.pending_accept_command_request
    assert pending is not None

    result = await execute_pending_accept_command_decision(
        session,
        confirm=True,
        request_id=pending['request_id'],
    )

    assert session.pending_accept_command_request is None
    assert 'Angular CLI summary' in result
    assert commands == [(str(ng_bin.resolve()), 'build')]
