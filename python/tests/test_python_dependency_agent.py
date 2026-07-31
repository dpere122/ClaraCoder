from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.accept_command import accept_command_sse_payload, execute_pending_accept_command_decision
from clara_coder_backend.tools.python_deps import (
    bootstrap_session_python_dependencies,
    freeze_python_requirements_tool,
    install_python_packages_tool,
    write_frozen_python_requirements_file_tool,
)
from clara_coder_backend.python_env import workspace_python_executable
from clara_coder_backend.state import current_session_id, get_session


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
def dependency_env():
    td = tempfile.TemporaryDirectory()
    project_root = Path(td.name) / 'python'
    project_root.mkdir()
    (project_root / 'requirements.txt').write_text('fastapi\n', encoding='utf-8')
    (project_root / 'requirements-dev.txt').write_text('pytest\n', encoding='utf-8')
    python_executable = workspace_python_executable(project_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    session_id = 'test-python-dependency-session'
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
    dependency_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root = dependency_env.project_root
    python_executable = dependency_env.python_executable
    session = dependency_env.session
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


@pytest.mark.asyncio
async def test_install_python_packages_stages_generic_accept_command_when_auto_apply_off(
    dependency_env,
) -> None:
    session = dependency_env.session

    result = await install_python_packages_tool.ainvoke({'packages': ['pytest', 'ruff']})

    assert 'Pending user confirmation' in result
    pending = session.pending_accept_command_request
    assert pending is not None
    payload = accept_command_sse_payload(pending)
    assert payload['kind'] == 'python_dependency'
    assert payload['title'] == 'Install Python packages'
    assert payload['confirmLabel'] == 'Install packages'
    assert 'pytest' in payload['commandText']
    assert 'ruff' in payload['commandText']
    # Regression guard: non-`run_command` accept-command kinds never carry a
    # `risk_assessment_status` key, so the payload must omit all risk fields
    # (byte-for-byte unchanged from before the command-risk-assess feature).
    assert 'risk_assessment_status' not in pending
    assert 'riskAssessmentStatus' not in payload
    assert 'riskLevel' not in payload
    assert 'riskDescription' not in payload


@pytest.mark.asyncio
async def test_accept_command_confirmation_runs_staged_dependency_install(
    dependency_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = dependency_env.session
    python_executable = dependency_env.python_executable
    commands: list[tuple[str, ...]] = []

    async def _fake_create_subprocess_exec(*args, **kwargs):
        commands.append(tuple(str(arg) for arg in args))
        return _FakeProc(output=b'installed packages\n')

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    await install_python_packages_tool.ainvoke({'packages': ['pytest', 'ruff']})
    pending = session.pending_accept_command_request
    assert pending is not None

    result = await execute_pending_accept_command_decision(
        session,
        confirm=True,
        request_id=pending['request_id'],
    )

    assert session.pending_accept_command_request is None
    assert 'Python dependency install summary' in result
    assert commands == [
        (str(python_executable), '-m', 'pip', 'install', 'pytest', 'ruff'),
    ]


@pytest.mark.asyncio
async def test_freeze_python_requirements_uses_workspace_python(
    dependency_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    python_executable = dependency_env.python_executable

    async def _fake_create_subprocess_exec(*args, **kwargs):
        assert args == (str(python_executable), '-m', 'pip', 'freeze')
        return _FakeProc(output=b'pytest==9.0.2\nruff==0.12.0\n')

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    result = await freeze_python_requirements_tool.ainvoke({})

    assert 'Python dependency freeze summary' in result
    assert 'pytest==9.0.2' in result


@pytest.mark.asyncio
async def test_write_frozen_python_requirements_file_writes_filtered_manifest(
    dependency_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    dependency_env.session.auto_apply_mode = True
    python_executable = dependency_env.python_executable
    output_path = dependency_env.project_root / 'requirements.txt'

    async def _fake_create_subprocess_exec(*args, **kwargs):
        assert args == (str(python_executable), '-m', 'pip', 'freeze')
        return _FakeProc(output=b'fastapi==0.115.0\njedi-language-server==0.46.0\n')

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    result = await write_frozen_python_requirements_file_tool.ainvoke({'output_file': 'requirements.txt'})

    assert 'Python dependency freeze file summary' in result
    assert 'Requirements file written: `requirements.txt`' in result
    assert output_path.read_text(encoding='utf-8') == 'fastapi==0.115.0\n'
