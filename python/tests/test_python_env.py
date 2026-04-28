from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from nemo_backend.domain import SessionState
from nemo_backend.lsp.python_server import build_python_lsp_command
from nemo_backend.python_env import (
    PythonWorkspaceEnvResult,
    _run_subprocess_with_output,
    ensure_session_python_workspace_env,
    resolve_python_workspace_root,
    workspace_python_executable,
)
from nemo_backend.routes_session import set_workspace_context
from nemo_backend.schemas import WorkspaceContextRequest
from nemo_backend.state import get_session

import pytest


@pytest.mark.asyncio
async def test_run_subprocess_with_output_times_out_and_kills(tmp_path: Path, monkeypatch) -> None:
    import nemo_backend.python_env as pe

    monkeypatch.setattr(pe, 'NEMO_SUBPROCESS_TIMEOUT_SEC', 1)

    proc = MagicMock()
    proc.returncode = None
    comm_calls = {'n': 0}

    async def communicate_impl():
        comm_calls['n'] += 1
        if comm_calls['n'] == 1:
            await asyncio.sleep(3600)
        return (b'', None)

    proc.communicate = communicate_impl
    proc.kill = MagicMock()
    proc.wait = AsyncMock(return_value=0)

    async def fake_exec(*_a, **_kw):
        return proc

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', fake_exec)

    code, out = await _run_subprocess_with_output([sys.executable, '-c', 'pass'], cwd=tmp_path)
    assert code is None
    assert 'timed out' in out.lower()
    proc.kill.assert_called()


@pytest.mark.asyncio
async def test_run_subprocess_with_output_uses_isolated_session_and_devnull(tmp_path: Path, monkeypatch) -> None:
    captured: dict[str, object] = {}

    orig = asyncio.create_subprocess_exec

    async def spy(*a, **kw):
        captured.update(kw)
        return await orig(*a, **kw)

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spy)

    code, out = await _run_subprocess_with_output(
        [sys.executable, '-c', 'print(42)'],
        cwd=tmp_path,
        timeout_sec=60.0,
    )
    assert code == 0
    assert '42' in out
    assert captured.get('stdin') == asyncio.subprocess.DEVNULL
    assert captured.get('start_new_session') is True


def test_build_python_lsp_command_prefers_workspace_venv(tmp_path: Path) -> None:
    workspace_root = tmp_path / 'workspace'
    workspace_root.mkdir()
    python_executable = workspace_python_executable(workspace_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    command = build_python_lsp_command(workspace_root)

    assert command == [str(python_executable), '-m', 'jedi_language_server.cli']


def test_build_python_lsp_command_prefers_adjacent_jedi_script(tmp_path: Path) -> None:
    workspace_root = tmp_path / 'workspace'
    workspace_root.mkdir()
    python_executable = workspace_python_executable(workspace_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    if sys.platform.startswith('win'):
        script_path = python_executable.parent / 'jedi-language-server.exe'
        script_path.write_text('', encoding='utf-8')
        expected = [str(script_path)]
    else:
        script_path = python_executable.parent / 'jedi-language-server'
        script_path.write_text('#!/bin/sh\n', encoding='utf-8')
        script_path.chmod(0o755)
        expected = [str(script_path)]

    command = build_python_lsp_command(workspace_root)

    assert command == expected


def test_resolve_python_workspace_root_accepts_simple_python_workspace(tmp_path: Path) -> None:
    workspace_root = tmp_path / 'workspace'
    workspace_root.mkdir()
    (workspace_root / 'main.py').write_text('print("hello")\n', encoding='utf-8')

    project_root, label = resolve_python_workspace_root(workspace_root, allow_workspace_root_fallback=False)

    assert project_root == workspace_root
    assert label == '.'


def test_ensure_session_python_workspace_env_applies_session_paths(monkeypatch, tmp_path: Path) -> None:
    workspace_root = tmp_path / 'workspace'
    workspace_root.mkdir()
    session = SessionState(workspace_path=str(workspace_root.resolve()))
    python_executable = workspace_python_executable(workspace_root)
    activated: list[Path] = []

    async def _fake_ensure(project_root_arg: Path, *, project_root_label: str, emit_chunk=None):
        assert project_root_arg == workspace_root
        assert project_root_label == '.'
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root_arg,
            project_root_label=project_root_label,
            venv_path=project_root_arg / '.venv',
            python_executable=python_executable,
            summary='Python workspace environment summary:\n- Workspace root: `.`\n',
        )

    monkeypatch.setattr('nemo_backend.python_env.ensure_python_workspace_env', _fake_ensure)
    monkeypatch.setattr(
        'nemo_backend.python_env.activate_process_workspace_python_env',
        lambda venv_path: activated.append(venv_path),
    )

    result = asyncio.run(ensure_session_python_workspace_env(session, allow_workspace_root_fallback=True))

    assert result is not None
    assert session.python_workspace_root == str(workspace_root)
    assert session.python_workspace_root_label == '.'
    assert session.python_workspace_venv_path == str(workspace_root / '.venv')
    assert session.python_workspace_python_executable == str(python_executable)
    assert session.python_workspace_bin_path == str(python_executable.parent)
    assert activated == [workspace_root / '.venv']


def test_ensure_session_python_workspace_env_bootstraps_dependencies_when_requested(monkeypatch, tmp_path: Path) -> None:
    workspace_root = tmp_path / 'workspace'
    workspace_root.mkdir()
    session = SessionState(workspace_path=str(workspace_root.resolve()))
    python_executable = workspace_python_executable(workspace_root)

    async def _fake_ensure(project_root_arg: Path, *, project_root_label: str, emit_chunk=None):
        assert project_root_arg == workspace_root
        assert project_root_label == '.'
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root_arg,
            project_root_label=project_root_label,
            venv_path=project_root_arg / '.venv',
            python_executable=python_executable,
            summary='env-ready',
        )

    async def _fake_bootstrap(session_arg, *, emit_chunk=None):
        assert session_arg is session
        return type(
            '_BootstrapResult',
            (),
            {
                'ok': True,
                'summary': 'deps-ready',
                'installed_requirements': ['requirements.txt', 'requirements-dev.txt'],
                'installed_packages': ['jedi-language-server'],
            },
        )()

    monkeypatch.setattr('nemo_backend.python_env.ensure_python_workspace_env', _fake_ensure)
    monkeypatch.setattr('nemo_backend.python_env.activate_process_workspace_python_env', lambda _venv_path: None)
    monkeypatch.setattr('nemo_backend.python_dependency_agent.bootstrap_session_python_dependencies', _fake_bootstrap)

    result = asyncio.run(
        ensure_session_python_workspace_env(
            session,
            allow_workspace_root_fallback=True,
            bootstrap_dependencies=True,
        )
    )

    assert result is not None
    assert result.ok is True
    assert result.installed_requirements == ['requirements.txt', 'requirements-dev.txt']
    assert result.installed_packages == ['jedi-language-server']
    assert 'env-ready' in result.summary
    assert 'deps-ready' in result.summary


def test_set_workspace_context_bootstraps_python_env_once_per_workspace(monkeypatch, tmp_path: Path) -> None:
    workspace_root = tmp_path / 'workspace'
    workspace_root.mkdir()
    session_id = 'python-env-route'
    calls: list[str] = []

    async def _fake_ensure_session(
        session_arg,
        *,
        allow_workspace_root_fallback: bool,
        bootstrap_dependencies: bool = False,
        emit_chunk=None,
    ):
        calls.append(session_arg.workspace_path)
        assert allow_workspace_root_fallback is False
        assert bootstrap_dependencies is True
        session_arg.python_workspace_python_executable = str(workspace_python_executable(workspace_root))
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=workspace_root,
            project_root_label='.',
            venv_path=workspace_root / '.venv',
            python_executable=workspace_python_executable(workspace_root),
            summary='ready',
        )

    monkeypatch.setattr('nemo_backend.routes_session.ensure_session_python_workspace_env', _fake_ensure_session)

    asyncio.run(
        set_workspace_context(
            WorkspaceContextRequest(
                session_id=session_id,
                workspace_path=str(workspace_root.resolve()),
                workspace_context='',
            )
        )
    )
    asyncio.run(
        set_workspace_context(
            WorkspaceContextRequest(
                session_id=session_id,
                workspace_path=str(workspace_root.resolve()),
                workspace_context='updated',
            )
        )
    )

    session = get_session(session_id)
    assert session.workspace_path == str(workspace_root.resolve())
    assert calls == [str(workspace_root.resolve())]
