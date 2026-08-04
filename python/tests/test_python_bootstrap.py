from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.runtime.python_bootstrap import bootstrap_session_python_dependencies
from clara_coder_backend.runtime.python_env import workspace_python_executable
from clara_coder_backend.session.state import current_session_id, get_session


class _FakeProc:
    def __init__(self, *, output: bytes = b'', returncode: int = 0) -> None:
        self.stdout = None
        self.stderr = None
        self.returncode = returncode
        self._output = output

    async def communicate(self) -> tuple[bytes, bytes]:
        await asyncio.sleep(0)
        return self._output, b''


@pytest.fixture()
def bootstrap_env():
    td = tempfile.TemporaryDirectory()
    project_root = Path(td.name) / 'python'
    project_root.mkdir()
    (project_root / 'requirements.txt').write_text('fastapi\n', encoding='utf-8')
    (project_root / 'requirements-dev.txt').write_text('pytest\n', encoding='utf-8')
    python_executable = workspace_python_executable(project_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    session_id = 'test-python-bootstrap-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(project_root.resolve())
    session.python_workspace_root = str(project_root.resolve())
    session.python_workspace_root_label = '.'
    session.python_workspace_venv_path = str(project_root / '.venv')
    session.python_workspace_python_executable = str(python_executable)
    session.python_workspace_bin_path = str(python_executable.parent)
    session.worker_apply_mode = True
    session.auto_apply_mode = False
    session.pending_accept_command_request = None

    class _Env:
        pass

    env = _Env()
    env.project_root = project_root  # type: ignore[attr-defined]
    env.python_executable = python_executable  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]

    yield env

    current_session_id.reset(token)
    td.cleanup()


@pytest.mark.asyncio
async def test_bootstrap_session_python_dependencies_uses_workspace_python_env(
    bootstrap_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root = bootstrap_env.project_root
    python_executable = bootstrap_env.python_executable
    session = bootstrap_env.session
    commands: list[tuple[str, ...]] = []

    async def _fake_create_subprocess_exec(*args, **kwargs):
        commands.append(tuple(str(arg) for arg in args))
        assert kwargs['cwd'] == str(project_root)
        if len(args) >= 3 and args[1] == '-c':
            return _FakeProc(returncode=1)
        return _FakeProc(output=f'ran {" ".join(str(arg) for arg in args)}\n'.encode('utf-8'))

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    result = await bootstrap_session_python_dependencies(session)

    assert result is not None
    assert result.ok is True
    assert result.installed_requirements == ['requirements.txt', 'requirements-dev.txt']
    assert result.installed_packages == ['jedi-language-server']
    assert 'Python workspace dependency bootstrap' in result.summary
    assert commands[0] == (str(python_executable), '-m', 'pip', 'install', '-r', 'requirements.txt')
    assert commands[1] == (str(python_executable), '-m', 'pip', 'install', '-r', 'requirements-dev.txt')
    assert commands[2][0] == str(python_executable)
    assert commands[2][1] == '-c'
    assert commands[3] == (
        str(python_executable),
        '-m',
        'pip',
        'install',
        'jedi-language-server>=0.46,<0.47',
    )
