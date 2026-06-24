from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from nemo_backend.agents.specialists.project_review_tools import (
    maybe_bootstrap_python_workspace_env_for_project_review,
    run_workspace_python_smoke_test,
    run_workspace_pytest_tests,
)
from nemo_backend.python_env import (
    PythonWorkspaceEnvResult,
    workspace_python_executable,
)
from nemo_backend.python_env_tools import ensure_python_workspace_env_tool
from nemo_backend.state import current_session_id, get_session, sessions


class _FakeAsyncStreamReader:
    """Minimal ``asyncio.StreamReader`` stand-in for chunk ``read()``-based subprocess pumps."""

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


@pytest.fixture()
def python_workspace(tmp_path: Path):
    project_root = tmp_path / 'python'
    (project_root / 'nemo_backend').mkdir(parents=True)
    (project_root / 'tests').mkdir(parents=True)
    (project_root / 'requirements.txt').write_text('fastapi\n', encoding='utf-8')
    (project_root / 'requirements-dev.txt').write_text('pytest\n', encoding='utf-8')
    (project_root / 'tests' / 'test_main.py').write_text('def test_value():\n    assert True\n', encoding='utf-8')

    session_id = 'project-review-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(tmp_path.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    session.abort_event.clear()
    session.planning_nested_events_q = asyncio.Queue()

    yield project_root, session

    current_session_id.reset(token)


@pytest.fixture()
def python_workspace_without_tests(tmp_path: Path):
    project_root = tmp_path / 'python'
    project_root.mkdir(parents=True)
    (project_root / 'todo_app.py').write_text('print("hello")\n', encoding='utf-8')

    session_id = 'project-review-no-tests'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(tmp_path.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    session.abort_event.clear()
    session.planning_nested_events_q = asyncio.Queue()

    yield project_root, session

    current_session_id.reset(token)

@pytest.mark.asyncio
async def test_project_review_bootstrap_path_installs_requirements_and_helpers(
    python_workspace, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root, session = python_workspace
    expected_python = workspace_python_executable(project_root)

    async def _fake_ensure_session(session_arg, *, allow_workspace_root_fallback: bool, bootstrap_dependencies: bool = False, emit_chunk=None):
        assert session_arg is session
        assert allow_workspace_root_fallback is False
        assert bootstrap_dependencies is True
        session_arg.python_workspace_root = str(project_root)
        session_arg.python_workspace_root_label = 'python/'
        session_arg.python_workspace_venv_path = str(project_root / '.venv')
        session_arg.python_workspace_python_executable = str(expected_python)
        session_arg.python_workspace_bin_path = str(expected_python.parent)
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root,
            project_root_label='python/',
            venv_path=project_root / '.venv',
            python_executable=expected_python,
            installed_requirements=['requirements.txt', 'requirements-dev.txt'],
            installed_packages=['jedi-language-server'],
            summary='ready\n\ndeps-ready',
        )

    monkeypatch.setattr(
        'nemo_backend.agents.specialists.project_review_tools.ensure_session_python_workspace_env',
        _fake_ensure_session,
    )

    result = await maybe_bootstrap_python_workspace_env_for_project_review('project-review-session')

    assert 'ready' in result
    assert 'deps-ready' in result


@pytest.mark.asyncio
async def test_run_workspace_pytest_tests_bootstraps_session_dependencies_first(
    python_workspace, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root, session = python_workspace
    expected_python = workspace_python_executable(project_root)
    expected_python.parent.mkdir(parents=True, exist_ok=True)
    expected_python.write_text('', encoding='utf-8')

    async def _fake_ensure_session(session_arg, *, allow_workspace_root_fallback: bool, bootstrap_dependencies: bool = False, emit_chunk=None):
        assert session_arg is session
        assert allow_workspace_root_fallback is False
        assert bootstrap_dependencies is True
        session_arg.python_workspace_root = str(project_root)
        session_arg.python_workspace_root_label = 'python/'
        session_arg.python_workspace_venv_path = str(project_root / '.venv')
        session_arg.python_workspace_python_executable = str(expected_python)
        session_arg.python_workspace_bin_path = str(expected_python.parent)
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root,
            project_root_label='python/',
            venv_path=project_root / '.venv',
            python_executable=expected_python,
            summary='env-ready',
        )

    class _PytestProc:
        def __init__(self) -> None:
            self.stdout = _FakeAsyncStreamReader(b'1 passed\n')
            self.stderr = _FakeAsyncStreamReader(b'')
            self.returncode: int | None = None

        async def wait(self) -> int:
            await asyncio.sleep(0)
            self.returncode = 0
            return 0

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    async def _fake_create_subprocess_exec(*args, **kwargs):
        assert args[:4] == (str(expected_python), '-m', 'pytest', 'tests')
        assert kwargs['cwd'] == str(project_root)
        return _PytestProc()

    monkeypatch.setattr(
        'nemo_backend.agents.specialists.project_review_tools.ensure_session_python_workspace_env',
        _fake_ensure_session,
    )
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    result = await run_workspace_pytest_tests.ainvoke({})

    assert 'Result: passed' in result
    assert 'env-ready' not in result


@pytest.mark.asyncio
async def test_run_workspace_pytest_tests_skips_when_workspace_has_no_pytest_signal(
    python_workspace_without_tests, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root, session = python_workspace_without_tests
    expected_python = workspace_python_executable(project_root)
    expected_python.parent.mkdir(parents=True, exist_ok=True)
    expected_python.write_text('', encoding='utf-8')

    async def _fake_ensure_session(session_arg, *, allow_workspace_root_fallback: bool, bootstrap_dependencies: bool = False, emit_chunk=None):
        assert session_arg is session
        assert allow_workspace_root_fallback is False
        assert bootstrap_dependencies is True
        session_arg.python_workspace_root = str(project_root)
        session_arg.python_workspace_root_label = 'python/'
        session_arg.python_workspace_venv_path = str(project_root / '.venv')
        session_arg.python_workspace_python_executable = str(expected_python)
        session_arg.python_workspace_bin_path = str(expected_python.parent)
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root,
            project_root_label='python/',
            venv_path=project_root / '.venv',
            python_executable=expected_python,
            summary='env-ready',
        )

    monkeypatch.setattr(
        'nemo_backend.agents.specialists.project_review_tools.ensure_session_python_workspace_env',
        _fake_ensure_session,
    )

    result = await run_workspace_pytest_tests.ainvoke({})

    assert 'Workspace pytest run skipped' in result
    assert 'no existing pytest suite' in result


@pytest.mark.asyncio
async def test_ensure_python_workspace_env_tool_uses_workspace_root(
    python_workspace, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root, _session = python_workspace
    python_executable = workspace_python_executable(project_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    async def _fake_ensure_session(
        session_arg,
        *,
        allow_workspace_root_fallback: bool,
        bootstrap_dependencies: bool = False,
        emit_chunk=None,
    ):
        assert session_arg.workspace_path == str(project_root.parent.resolve())
        assert allow_workspace_root_fallback is True
        assert bootstrap_dependencies is True
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root,
            project_root_label='python/',
            venv_path=project_root / '.venv',
            python_executable=python_executable,
            summary='Python workspace environment summary:\n- Workspace root: `python/`\n',
        )

    monkeypatch.setattr(
        'nemo_backend.python_env_tools.ensure_session_python_workspace_env',
        _fake_ensure_session,
    )

    result = await ensure_python_workspace_env_tool.ainvoke({})

    assert 'Workspace root: `python/`' in result


@pytest.mark.asyncio
async def test_project_review_bootstrap_creates_workspace_env_when_python_workspace_exists(
    python_workspace, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root, _session = python_workspace
    python_executable = workspace_python_executable(project_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    async def _fake_ensure_session(
        session_arg,
        *,
        allow_workspace_root_fallback: bool,
        bootstrap_dependencies: bool = False,
        emit_chunk=None,
    ):
        assert session_arg.workspace_path == str(project_root.parent.resolve())
        assert allow_workspace_root_fallback is False
        assert bootstrap_dependencies is True
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root,
            project_root_label='python/',
            venv_path=project_root / '.venv',
            python_executable=python_executable,
            summary='Python workspace environment summary:\n- Workspace root: `python/`\n',
        )

    monkeypatch.setattr(
        'nemo_backend.agents.specialists.project_review_tools.ensure_session_python_workspace_env',
        _fake_ensure_session,
    )

    result = await maybe_bootstrap_python_workspace_env_for_project_review('project-review-session')

    assert 'Workspace root: `python/`' in result


@pytest.mark.asyncio
async def test_project_review_bootstrap_skips_non_python_workspace(tmp_path: Path) -> None:
    session_id = 'project-review-non-python'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(tmp_path.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    session.abort_event.clear()
    session.planning_nested_events_q = asyncio.Queue()

    try:
        result = await maybe_bootstrap_python_workspace_env_for_project_review(session_id)
    finally:
        current_session_id.reset(token)

    assert result == ''


@pytest.mark.asyncio
async def test_run_workspace_pytest_tests_uses_workspace_python_and_streams_output(
    python_workspace, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root, session = python_workspace
    python_executable = workspace_python_executable(project_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    async def _fake_ensure_session(session_arg, *, allow_workspace_root_fallback: bool, bootstrap_dependencies: bool = False, emit_chunk=None):
        assert session_arg is session
        assert allow_workspace_root_fallback is False
        assert bootstrap_dependencies is True
        session_arg.python_workspace_root = str(project_root)
        session_arg.python_workspace_root_label = 'python/'
        session_arg.python_workspace_venv_path = str(project_root / '.venv')
        session_arg.python_workspace_python_executable = str(python_executable)
        session_arg.python_workspace_bin_path = str(python_executable.parent)
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root,
            project_root_label='python/',
            venv_path=project_root / '.venv',
            python_executable=python_executable,
            summary='ready',
        )

    class _PytestProc:
        def __init__(self) -> None:
            self.stdout = _FakeAsyncStreamReader(b'test session starts\n1 passed\n')
            self.stderr = _FakeAsyncStreamReader(b'')
            self.returncode: int | None = None

        async def wait(self) -> int:
            await asyncio.sleep(0)
            self.returncode = 0
            return 0

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    async def _fake_create_subprocess_exec(*args, **kwargs):
        assert args[:4] == (str(python_executable), '-m', 'pytest', 'tests')
        assert args[4] == '-v'
        assert kwargs['cwd'] == str(project_root)
        return _PytestProc()

    monkeypatch.setattr(
        'nemo_backend.agents.specialists.project_review_tools.ensure_session_python_workspace_env',
        _fake_ensure_session,
    )
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    result = await run_workspace_pytest_tests.ainvoke({})

    assert 'Result: passed' in result
    assert f'`{python_executable} -m pytest tests -v`' in result
    streamed = []
    while not session.planning_nested_events_q.empty():
        streamed.append(await session.planning_nested_events_q.get())
    assert any(
        item[1].get('event') == 'tool_exec_chunk'
        and 'test session starts' in (item[1].get('data') or {}).get('delta', '')
        for item in streamed
    )
    complete_events = [item for item in streamed if item[1].get('event') == 'tool_exec_complete']
    assert complete_events
    excerpt = (complete_events[-1][1].get('data') or {}).get('output_excerpt', '')
    assert '1 passed' in excerpt


@pytest.mark.asyncio
async def test_run_workspace_pytest_tests_aborts_process_when_session_cancelled(
    python_workspace, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root, session = python_workspace
    python_executable = workspace_python_executable(project_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    async def _fake_ensure_session(session_arg, *, allow_workspace_root_fallback: bool, bootstrap_dependencies: bool = False, emit_chunk=None):
        assert session_arg is session
        assert allow_workspace_root_fallback is False
        assert bootstrap_dependencies is True
        session_arg.python_workspace_root = str(project_root)
        session_arg.python_workspace_root_label = 'python/'
        session_arg.python_workspace_venv_path = str(project_root / '.venv')
        session_arg.python_workspace_python_executable = str(python_executable)
        session_arg.python_workspace_bin_path = str(python_executable.parent)
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root,
            project_root_label='python/',
            venv_path=project_root / '.venv',
            python_executable=python_executable,
            summary='ready',
        )

    class _PytestProc:
        def __init__(self) -> None:
            self.stdout = _FakeAsyncStreamReader(b'')
            self.stderr = _FakeAsyncStreamReader(b'')
            self.returncode: int | None = None
            self.terminated = False

        async def wait(self) -> int:
            await asyncio.sleep(0.5)
            self.returncode = self.returncode if self.returncode is not None else 0
            return self.returncode

        def terminate(self) -> None:
            self.terminated = True
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = _PytestProc()

    async def _fake_create_subprocess_exec(*_args, **_kwargs):
        return fake_proc

    monkeypatch.setattr(
        'nemo_backend.agents.specialists.project_review_tools.ensure_session_python_workspace_env',
        _fake_ensure_session,
    )
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    async def _abort_soon() -> None:
        await asyncio.sleep(0.01)
        session.abort_event.set()

    abort_task = asyncio.create_task(_abort_soon())
    try:
        result = await run_workspace_pytest_tests.ainvoke({})
    finally:
        await abort_task

    assert result == 'Aborted by user.'
    assert fake_proc.terminated is True


@pytest.mark.asyncio
async def test_run_workspace_python_smoke_test_uses_workspace_entrypoint_and_reports_steady_state(
    python_workspace_without_tests, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root, session = python_workspace_without_tests
    python_executable = workspace_python_executable(project_root)
    python_executable.parent.mkdir(parents=True, exist_ok=True)
    python_executable.write_text('', encoding='utf-8')

    async def _fake_ensure_session(session_arg, *, allow_workspace_root_fallback: bool, bootstrap_dependencies: bool = False, emit_chunk=None):
        assert session_arg is session
        assert allow_workspace_root_fallback is False
        assert bootstrap_dependencies is True
        session_arg.python_workspace_root = str(project_root)
        session_arg.python_workspace_root_label = 'python/'
        session_arg.python_workspace_venv_path = str(project_root / '.venv')
        session_arg.python_workspace_python_executable = str(python_executable)
        session_arg.python_workspace_bin_path = str(python_executable.parent)
        return PythonWorkspaceEnvResult(
            ok=True,
            project_root=project_root,
            project_root_label='python/',
            venv_path=project_root / '.venv',
            python_executable=python_executable,
            summary='ready',
        )

    class _SmokeProc:
        def __init__(self) -> None:
            self.stdout = _FakeAsyncStreamReader(b'')
            self.stderr = _FakeAsyncStreamReader(b'')
            self.returncode: int | None = None
            self.terminated = False

        async def wait(self) -> int:
            await asyncio.sleep(10)
            self.returncode = self.returncode if self.returncode is not None else 0
            return self.returncode

        def terminate(self) -> None:
            self.terminated = True
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    fake_proc = _SmokeProc()

    async def _fake_create_subprocess_exec(*args, **kwargs):
        assert args == (str(python_executable), 'todo_app.py')
        assert kwargs['cwd'] == str(project_root)
        return fake_proc

    monkeypatch.setattr(
        'nemo_backend.agents.specialists.project_review_tools.ensure_session_python_workspace_env',
        _fake_ensure_session,
    )
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', _fake_create_subprocess_exec)

    result = await run_workspace_python_smoke_test.ainvoke({})

    assert 'Workspace Python smoke-test summary' in result
    assert 'startup reached steady state' in result
    assert fake_proc.terminated is True
