"""Tools for the final project reviewer specialist."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from collections.abc import Callable
from pathlib import Path

from langchain_core.tools import tool

from nemo_backend.lsp.tools import (
    lsp_find_definition,
    lsp_find_references,
    lsp_get_diagnostics,
    lsp_get_document_symbols,
    lsp_hover,
)
from nemo_backend.angular_cli_tool import angular_cli_tool
from nemo_backend.node_dependency_agent import (
    _build_run_script_args,
    _package_json_script_gate,
    _resolve_project_dir,
    detect_package_manager,
    install_npm_packages_tool,
    npm_install_project_tool,
    remove_npm_packages_tool,
    run_npm_script_tool,
)
from nemo_backend.node_project_discovery import discover_npm_projects_tool
from nemo_backend.npm_registry_search import search_npm_packages_tool
from nemo_backend.process_tools import kill_process_tool, search_netstat_ports_tool
from nemo_backend.python_dependency_agent import (
    freeze_python_requirements_tool,
    install_python_packages_tool,
    install_python_requirements_file_tool,
    write_frozen_python_requirements_file_tool,
)
from nemo_backend.config import NEMO_SUBPROCESS_TIMEOUT_SEC
from nemo_backend.subprocess_smoke import (
    SmokeOutputTracker,
    SmokeStopReason,
    argv_implies_watch_mode,
    wait_for_smoke_completion,
)
from nemo_backend.python_env import (
    _terminate_subprocess_tree,
    ensure_session_python_workspace_env,
    session_workspace_subprocess_env,
    with_subprocess_color_env,
)
from nemo_backend.deferred_tool_hitl import maybe_await_hitl_for_deferred_tool
from nemo_backend.python_env_tools import ensure_python_workspace_env_tool
from nemo_backend.state import current_session_id, get_session
from nemo_backend.stream_tags import (
    TOOL_NODE_SMOKE_STREAM_TAG,
    TOOL_PYTEST_STREAM_TAG,
    TOOL_SMOKE_STREAM_TAG,
)
from nemo_backend.workspace_index.semantic_tool import retrieve_workspace_semantic
from nemo_backend.workspace_tools import (
    get_active_workspace_root,
    list_workspace_directory,
    read_workspace_file,
    search_workspace,
    truncate_text,
    truncate_text_head_tail,
)

logger = logging.getLogger('nemo.project_review')

RUN_WORKSPACE_PYTEST_TESTS_NAME = 'run_workspace_pytest_tests'
RUN_WORKSPACE_PYTHON_SMOKE_TEST_NAME = 'run_workspace_python_smoke_test'
RUN_WORKSPACE_NODE_SMOKE_TEST_NAME = 'run_workspace_node_smoke_test'
APPROVE_PROJECT_REVIEW_NAME = 'approve_project_review'
REJECT_PROJECT_REVIEW_NAME = 'reject_project_review'
_PYTEST_STREAM_TAG = TOOL_PYTEST_STREAM_TAG
_PYTEST_STREAM_LABEL = 'Workspace Pytest'
_SMOKE_STREAM_TAG = TOOL_SMOKE_STREAM_TAG
_SMOKE_STREAM_LABEL = 'Workspace Smoke Test'
_NODE_SMOKE_STREAM_TAG = TOOL_NODE_SMOKE_STREAM_TAG
_NODE_SMOKE_STREAM_LABEL = 'Workspace Node Smoke Test'
_NODE_SMOKE_SCRIPT_CANDIDATES = ('smoke', 'dev', 'start', 'serve', 'preview')
_SMOKE_ENTRYPOINT_CANDIDATES = (
    'main.py',
    'app.py',
    'run.py',
    'manage.py',
    'todo_app.py',
)
_SUBPROCESS_READ_SIZE = 65536
_TOOL_EXEC_COMPLETE_REPLAY_CHARS = 12_000
_SUBPROCESS_STASH_MAX_CHARS = 80_000


async def _emit_project_review_chunk(
    session_id: str,
    delta: str,
    *,
    stream_tag: str = _PYTEST_STREAM_TAG,
    label: str = _PYTEST_STREAM_LABEL,
) -> None:
    if not delta:
        return
    session = get_session(session_id)
    queue = session.planning_nested_events_q
    if queue is None:
        return
    await queue.put(
        (
            stream_tag,
            {
                'event': 'tool_exec_chunk',
                'data': {
                    'delta': delta,
                    'stream_tag': stream_tag,
                    'label': label,
                },
            },
        )
    )


async def _emit_project_review_tool_complete(
    session_id: str,
    *,
    stream_tag: str,
    label: str,
    exit_code: int | None,
    output_excerpt: str = '',
    outcome: str | None = None,
) -> None:
    session = get_session(session_id)
    queue = session.planning_nested_events_q
    if queue is None:
        return
    payload: dict[str, object] = {
        'stream_tag': stream_tag,
        'label': label,
        'exit_code': exit_code,
    }
    excerpt = output_excerpt.strip()
    if excerpt:
        payload['output_excerpt'] = excerpt
    if outcome in ('passed', 'failed'):
        payload['outcome'] = outcome
    await queue.put((stream_tag, {'event': 'tool_exec_complete', 'data': payload}))


def _combined_raw_streams(stdout_chunks: list[str], stderr_chunks: list[str]) -> str:
    stdout = ''.join(stdout_chunks)
    stderr = ''.join(stderr_chunks)
    if stderr:
        return f'{stdout}\n[stderr]\n{stderr}' if stdout else f'[stderr]\n{stderr}'
    return stdout


def _stash_subprocess_output_and_replay_tail(
    session_id: str,
    stdout_chunks: list[str],
    stderr_chunks: list[str],
) -> str:
    combined = _combined_raw_streams(stdout_chunks, stderr_chunks).strip()
    if not combined:
        return ''
    session = get_session(session_id)
    session.last_project_review_subprocess_report = truncate_text(combined, _SUBPROCESS_STASH_MAX_CHARS)
    if len(combined) <= _TOOL_EXEC_COMPLETE_REPLAY_CHARS:
        return combined
    return combined[-_TOOL_EXEC_COMPLETE_REPLAY_CHARS:]


async def _pump_subprocess_stream(
    stream: asyncio.StreamReader | None,
    *,
    session_id: str,
    emit_prefix: str,
    capture_chunks: list[str],
    stream_tag: str = _PYTEST_STREAM_TAG,
    label: str = _PYTEST_STREAM_LABEL,
    on_text: Callable[[str], None] | None = None,
) -> None:
    if stream is None:
        return
    while True:
        block = await stream.read(_SUBPROCESS_READ_SIZE)
        if not block:
            break
        text = block.decode('utf-8', errors='replace')
        capture_chunks.append(text)
        if on_text is not None:
            on_text(text)
        rendered = f'{emit_prefix}{text}' if emit_prefix else text
        await _emit_project_review_chunk(session_id, rendered, stream_tag=stream_tag, label=label)


def _build_pytest_result(
    *,
    exit_code: int | None,
    project_root_label: str,
    python_executable: str,
    stdout_chunks: list[str],
    stderr_chunks: list[str],
) -> str:
    stdout = ''.join(stdout_chunks)
    stderr = ''.join(stderr_chunks)
    combined = stdout
    if stderr:
        combined = f'{combined}\n[stderr]\n{stderr}' if combined else f'[stderr]\n{stderr}'
    combined = combined.strip()
    status = 'passed' if exit_code == 0 else 'failed'
    body = (
        'Workspace pytest run summary:\n'
        f'- Command: `{python_executable} -m pytest tests -v`\n'
        f'- Ran from workspace: `{project_root_label}`\n'
        f'- Result: {status}\n'
        f'- Exit code: {exit_code if exit_code is not None else "unknown"}\n'
    )
    if combined:
        body += f'\nCaptured output:\n{combined}'
    return truncate_text_head_tail(body, 120_000)


def _has_pytest_workspace_signal(project_root: Path) -> bool:
    tests_dir = project_root / 'tests'
    if tests_dir.is_dir() and any(tests_dir.rglob('test_*.py')):
        return True
    if any(project_root.rglob('*_test.py')):
        return True
    if (project_root / 'pytest.ini').is_file():
        return True
    if (project_root / 'conftest.py').is_file():
        return True
    pyproject = project_root / 'pyproject.toml'
    if pyproject.is_file():
        try:
            text = pyproject.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            text = ''
        if '[tool.pytest' in text or 'pytest' in text:
            return True
    for requirement_name in ('requirements-dev.txt', 'requirements.txt'):
        req_path = project_root / requirement_name
        if not req_path.is_file():
            continue
        try:
            req_text = req_path.read_text(encoding='utf-8', errors='ignore').lower()
        except OSError:
            req_text = ''
        if 'pytest' in req_text:
            return True
    return False


def _discover_python_smoke_entry(project_root: Path) -> str:
    for candidate in _SMOKE_ENTRYPOINT_CANDIDATES:
        path = project_root / candidate
        if path.is_file():
            return candidate
    top_level_py_files = sorted(
        path.name
        for path in project_root.iterdir()
        if path.is_file() and path.suffix == '.py' and not path.name.startswith('test_')
    )
    if len(top_level_py_files) == 1:
        return top_level_py_files[0]
    for path in sorted(project_root.rglob('*.py')):
        rel = path.relative_to(project_root).as_posix()
        if rel.startswith('tests/'):
            continue
        try:
            text = path.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        if "__name__ == '__main__'" in text or '__name__ == "__main__"' in text:
            return rel
    return ''


def _resolve_python_smoke_entry(project_root: Path, relative_path: str) -> tuple[Path | None, str]:
    cleaned = (relative_path or '').strip().replace('\\', '/')
    if not cleaned:
        cleaned = _discover_python_smoke_entry(project_root)
    if not cleaned:
        return None, ''
    candidate = (project_root / cleaned).resolve()
    try:
        candidate.relative_to(project_root.resolve())
    except ValueError:
        return None, 'Tool error: smoke-test entry path must stay inside the active workspace.'
    if not candidate.is_file():
        return None, f'Tool error: smoke-test entry path does not exist: `{cleaned}`.'
    return candidate, cleaned


def _build_smoke_result(
    *,
    exit_code: int | None,
    project_root_label: str,
    python_executable: str,
    entry_path: str,
    stdout_chunks: list[str],
    stderr_chunks: list[str],
    steady_state: bool,
    readiness_detected: bool = False,
    passed: bool | None = None,
    failure_detail: str = '',
) -> str:
    stdout = ''.join(stdout_chunks)
    stderr = ''.join(stderr_chunks)
    combined = stdout
    if stderr:
        combined = f'{combined}\n[stderr]\n{stderr}' if combined else f'[stderr]\n{stderr}'
    combined = combined.strip()
    if passed is None:
        passed = exit_code == 0 if not steady_state else True
    if steady_state and readiness_detected:
        status = 'passed (dev server readiness detected)'
    elif steady_state:
        status = 'passed (startup reached steady state)'
    elif passed:
        status = 'passed'
    else:
        status = 'failed'
    body = (
        'Workspace Python smoke-test summary:\n'
        f'- Command: `{python_executable} {entry_path}`\n'
        f'- Ran from workspace: `{project_root_label}`\n'
        f'- Result: {status}\n'
        f'- Exit code: {exit_code if exit_code is not None else "unknown"}\n'
    )
    if failure_detail.strip():
        body += f'- Failure signal: {failure_detail.strip()}\n'
    if combined:
        body += f'\nCaptured output:\n{combined}'
    return truncate_text_head_tail(body, 120_000)


async def _terminate_process(proc: asyncio.subprocess.Process) -> int | None:
    """Terminate the subprocess tree (npm/pytest often spawn children).

    Falls back to terminate/kill when ``pid`` is absent (tests use lightweight mocks).
    """
    if proc.returncode is not None:
        return proc.returncode
    pid = getattr(proc, 'pid', None)
    if isinstance(pid, int) and pid > 0:
        await _terminate_subprocess_tree(proc)
        return proc.returncode
    try:
        proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=3.0)
    except (ProcessLookupError, asyncio.TimeoutError):
        try:
            proc.kill()
            await asyncio.wait_for(proc.wait(), timeout=3.0)
        except (ProcessLookupError, asyncio.TimeoutError):
            return proc.returncode
    return proc.returncode


def _resolve_project_root_or_error() -> tuple[str | None, object | None]:
    try:
        workspace_root = get_active_workspace_root()
    except ValueError as exc:
        return f'Tool error: {exc}', None
    from nemo_backend.python_env import resolve_python_workspace_root

    project_root, project_root_label = resolve_python_workspace_root(workspace_root)
    if project_root is None:
        return 'Tool error: could not locate a Python pytest workspace from the active workspace.', None
    return None, (project_root, project_root_label)


async def maybe_bootstrap_python_workspace_env_for_project_review(session_id: str) -> str:
    """Create or reuse the workspace `.venv` before final project review when a Python workspace exists."""

    session = get_session(session_id)
    result = await ensure_session_python_workspace_env(
        session,
        allow_workspace_root_fallback=False,
        bootstrap_dependencies=True,
        emit_chunk=lambda delta: _emit_project_review_chunk(session_id, delta),
    )
    return '' if result is None else result.summary


@tool(RUN_WORKSPACE_PYTEST_TESTS_NAME)
async def run_workspace_pytest_tests() -> str:
    """Ensure the workspace `.venv` exists, then run `pytest` in that workspace environment."""

    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    pending = maybe_await_hitl_for_deferred_tool(session, tool_name=RUN_WORKSPACE_PYTEST_TESTS_NAME, tool_input={})
    if pending:
        return pending
    env_result = await ensure_session_python_workspace_env(
        session,
        allow_workspace_root_fallback=False,
        bootstrap_dependencies=True,
        emit_chunk=lambda delta: _emit_project_review_chunk(sid, delta),
    )
    if env_result is None:
        return 'Tool error: could not locate a Python pytest workspace from the active workspace.'
    if not env_result.ok or env_result.python_executable is None or env_result.project_root is None:
        return env_result.summary

    python_executable = str(env_result.python_executable)
    project_root = env_result.project_root
    project_root_label = env_result.project_root_label
    if not _has_pytest_workspace_signal(project_root):
        return (
            'Workspace pytest run skipped:\n'
            f'- Ran from workspace: `{project_root_label}`\n'
            '- Reason: no existing pytest suite, pytest config, or pytest dependency signal was found.\n'
            '- Guidance: prefer a smoke run or targeted manual verification instead of inventing tests during final review.'
        )
    await _emit_project_review_chunk(sid, f'$ {python_executable} -m pytest tests -v\n')
    try:
        proc = await asyncio.create_subprocess_exec(
            python_executable,
            '-m',
            'pytest',
            'tests',
            '-v',
            '--color=yes',
            cwd=str(project_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=with_subprocess_color_env(session_workspace_subprocess_env(session)),
        )
    except OSError as exc:
        await _emit_project_review_tool_complete(
            sid,
            stream_tag=_PYTEST_STREAM_TAG,
            label=_PYTEST_STREAM_LABEL,
            exit_code=None,
            output_excerpt='',
        )
        return f'Tool error: could not start workspace pytest ({exc}).'

    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    stdout_task = asyncio.create_task(
        _pump_subprocess_stream(
            proc.stdout,
            session_id=sid,
            emit_prefix='',
            capture_chunks=stdout_chunks,
        )
    )
    stderr_task = asyncio.create_task(
        _pump_subprocess_stream(
            proc.stderr,
            session_id=sid,
            emit_prefix='[stderr] ',
            capture_chunks=stderr_chunks,
        )
    )
    wait_task = asyncio.create_task(proc.wait())
    abort_task = asyncio.create_task(session.abort_event.wait())
    try:
        timeout_sec = (
            float(NEMO_SUBPROCESS_TIMEOUT_SEC)
            if NEMO_SUBPROCESS_TIMEOUT_SEC and NEMO_SUBPROCESS_TIMEOUT_SEC > 0
            else None
        )
        if timeout_sec is not None:
            done, _pending = await asyncio.wait(
                {wait_task, abort_task},
                timeout=timeout_sec,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                await _emit_project_review_chunk(sid, '\n[workspace pytest timed out]\n')
                await _terminate_process(proc)
                await wait_task
                exit_code = proc.returncode
                replay = _stash_subprocess_output_and_replay_tail(sid, stdout_chunks, stderr_chunks)
                await _emit_project_review_tool_complete(
                    sid,
                    stream_tag=_PYTEST_STREAM_TAG,
                    label=_PYTEST_STREAM_LABEL,
                    exit_code=exit_code,
                    output_excerpt=replay,
                )
                return _build_pytest_result(
                    exit_code=exit_code,
                    project_root_label=project_root_label,
                    python_executable=python_executable,
                    stdout_chunks=stdout_chunks,
                    stderr_chunks=stderr_chunks,
                )
        else:
            done, _pending = await asyncio.wait({wait_task, abort_task}, return_when=asyncio.FIRST_COMPLETED)
        if wait_task in done:
            exit_code = await wait_task
        elif abort_task in done and session.abort_event.is_set():
            await _emit_project_review_chunk(sid, '\n[workspace pytest aborted by user]\n')
            await _terminate_process(proc)
            await wait_task
            replay = _stash_subprocess_output_and_replay_tail(sid, stdout_chunks, stderr_chunks)
            await _emit_project_review_tool_complete(
                sid,
                stream_tag=_PYTEST_STREAM_TAG,
                label=_PYTEST_STREAM_LABEL,
                exit_code=proc.returncode,
                output_excerpt=replay,
            )
            return 'Aborted by user.'
        else:
            exit_code = await wait_task
    finally:
        if not abort_task.done():
            abort_task.cancel()
            try:
                await abort_task
            except asyncio.CancelledError:
                pass
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    logger.info('run_workspace_pytest_tests exit_code=%s project_root=%s', exit_code, project_root)
    replay = _stash_subprocess_output_and_replay_tail(sid, stdout_chunks, stderr_chunks)
    await _emit_project_review_tool_complete(
        sid,
        stream_tag=_PYTEST_STREAM_TAG,
        label=_PYTEST_STREAM_LABEL,
        exit_code=exit_code,
        output_excerpt=replay,
    )
    return _build_pytest_result(
        exit_code=exit_code,
        project_root_label=project_root_label,
        python_executable=python_executable,
        stdout_chunks=stdout_chunks,
        stderr_chunks=stderr_chunks,
    )


@tool(RUN_WORKSPACE_PYTHON_SMOKE_TEST_NAME)
async def run_workspace_python_smoke_test(relative_path: str = '') -> str:
    """Run a short-lived Python app smoke test for a workspace entry script, then stop it if it stays up."""

    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    tool_input = {'relative_path': relative_path}
    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=RUN_WORKSPACE_PYTHON_SMOKE_TEST_NAME,
        tool_input=tool_input,
    )
    if pending:
        return pending
    env_result = await ensure_session_python_workspace_env(
        session,
        allow_workspace_root_fallback=False,
        bootstrap_dependencies=True,
        emit_chunk=lambda delta: _emit_project_review_chunk(
            sid,
            delta,
            stream_tag=_SMOKE_STREAM_TAG,
            label=_SMOKE_STREAM_LABEL,
        ),
    )
    if env_result is None:
        return 'Tool error: could not locate a Python workspace from the active workspace.'
    if not env_result.ok or env_result.python_executable is None or env_result.project_root is None:
        return env_result.summary

    python_executable = str(env_result.python_executable)
    project_root = env_result.project_root
    project_root_label = env_result.project_root_label
    entry_path, entry_detail = _resolve_python_smoke_entry(project_root, relative_path)
    if entry_path is None and entry_detail:
        return entry_detail
    if entry_path is None:
        return (
            'Workspace Python smoke test skipped:\n'
            f'- Ran from workspace: `{project_root_label}`\n'
            '- Reason: no obvious runnable Python entrypoint was detected.'
        )
    rel_entry = entry_detail or entry_path.relative_to(project_root).as_posix()
    await _emit_project_review_chunk(
        sid,
        f'$ {python_executable} {rel_entry}\n',
        stream_tag=_SMOKE_STREAM_TAG,
        label=_SMOKE_STREAM_LABEL,
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            python_executable,
            rel_entry,
            cwd=str(project_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=with_subprocess_color_env(session_workspace_subprocess_env(session)),
        )
    except OSError as exc:
        await _emit_project_review_tool_complete(
            sid,
            stream_tag=_SMOKE_STREAM_TAG,
            label=_SMOKE_STREAM_LABEL,
            exit_code=None,
            output_excerpt='',
        )
        return f'Tool error: could not start workspace smoke test ({exc}).'

    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    tracker = SmokeOutputTracker()

    def _track_output(text: str) -> None:
        tracker.feed(text)

    stdout_task = asyncio.create_task(
        _pump_subprocess_stream(
            proc.stdout,
            session_id=sid,
            emit_prefix='',
            capture_chunks=stdout_chunks,
            stream_tag=_SMOKE_STREAM_TAG,
            label=_SMOKE_STREAM_LABEL,
            on_text=_track_output,
        )
    )
    stderr_task = asyncio.create_task(
        _pump_subprocess_stream(
            proc.stderr,
            session_id=sid,
            emit_prefix='[stderr] ',
            capture_chunks=stderr_chunks,
            stream_tag=_SMOKE_STREAM_TAG,
            label=_SMOKE_STREAM_LABEL,
            on_text=_track_output,
        )
    )
    wait_task = asyncio.create_task(proc.wait())
    abort_task = asyncio.create_task(session.abort_event.wait())

    async def _emit_smoke_status(message: str) -> None:
        await _emit_project_review_chunk(
            sid,
            message,
            stream_tag=_SMOKE_STREAM_TAG,
            label=_SMOKE_STREAM_LABEL,
        )

    try:
        smoke_result = await wait_for_smoke_completion(
            proc,
            wait_task=wait_task,
            abort_task=abort_task,
            tracker=tracker,
            terminate_fn=_terminate_process,
            emit_status=_emit_smoke_status,
            watch_mode=False,
        )
    finally:
        if not abort_task.done():
            abort_task.cancel()
            try:
                await abort_task
            except asyncio.CancelledError:
                pass
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    if smoke_result.stop_reason is SmokeStopReason.ABORTED:
        replay = _stash_subprocess_output_and_replay_tail(sid, stdout_chunks, stderr_chunks)
        await _emit_project_review_tool_complete(
            sid,
            stream_tag=_SMOKE_STREAM_TAG,
            label=_SMOKE_STREAM_LABEL,
            exit_code=smoke_result.exit_code,
            output_excerpt=replay,
            outcome='failed',
        )
        return 'Aborted by user.'

    replay = _stash_subprocess_output_and_replay_tail(sid, stdout_chunks, stderr_chunks)
    await _emit_project_review_tool_complete(
        sid,
        stream_tag=_SMOKE_STREAM_TAG,
        label=_SMOKE_STREAM_LABEL,
        exit_code=smoke_result.exit_code,
        output_excerpt=replay,
        outcome='passed' if smoke_result.passed else 'failed',
    )
    return _build_smoke_result(
        exit_code=smoke_result.exit_code,
        project_root_label=project_root_label,
        python_executable=python_executable,
        entry_path=rel_entry,
        stdout_chunks=stdout_chunks,
        stderr_chunks=stderr_chunks,
        steady_state=smoke_result.steady_state,
        readiness_detected=smoke_result.readiness_detected,
        passed=smoke_result.passed,
        failure_detail=smoke_result.failure_detail,
    )


def _package_json_scripts(project_dir: Path) -> dict[str, str]:
    path = project_dir / 'package.json'
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}
    scripts = data.get('scripts')
    if not isinstance(scripts, dict):
        return {}
    return {str(k): str(v) for k, v in scripts.items() if str(k).strip()}


def _discover_node_smoke_script(project_dir: Path) -> str:
    scripts = _package_json_scripts(project_dir)
    for candidate in _NODE_SMOKE_SCRIPT_CANDIDATES:
        if candidate in scripts:
            return candidate
    return ''


def _build_node_smoke_result(
    *,
    exit_code: int | None,
    project_label: str,
    command_text: str,
    script_name: str,
    stdout_chunks: list[str],
    stderr_chunks: list[str],
    steady_state: bool,
    readiness_detected: bool = False,
    passed: bool | None = None,
    failure_detail: str = '',
) -> str:
    stdout = ''.join(stdout_chunks)
    stderr = ''.join(stderr_chunks)
    combined = stdout
    if stderr:
        combined = f'{combined}\n[stderr]\n{stderr}' if combined else f'[stderr]\n{stderr}'
    combined = combined.strip()
    if passed is None:
        passed = exit_code == 0 if not steady_state else True
    if steady_state and readiness_detected:
        status = 'passed (dev server readiness detected)'
    elif steady_state:
        status = 'passed (startup reached steady state)'
    elif passed:
        status = 'passed'
    else:
        status = 'failed'
    body = (
        'Workspace Node.js smoke-test summary:\n'
        f'- Command: `{command_text}`\n'
        f'- Project: `{project_label}`\n'
        f'- Script: `{script_name}`\n'
        f'- Result: {status}\n'
        f'- Exit code: {exit_code if exit_code is not None else "unknown"}\n'
    )
    if failure_detail.strip():
        body += f'- Failure signal: {failure_detail.strip()}\n'
    if combined:
        body += f'\nCaptured output:\n{combined}'
    return truncate_text_head_tail(body, 120_000)


@tool(RUN_WORKSPACE_NODE_SMOKE_TEST_NAME)
async def run_workspace_node_smoke_test(relative_project_dir: str = '', script_name: str = '') -> str:
    """Run a Node.js package script smoke test (npm/pnpm/yarn ``run``) and stop watch-mode dev servers when ready.

    Discovers ``smoke``, ``dev``, ``start``, ``serve``, or ``preview`` from ``package.json`` when ``script_name`` is
    omitted. Detects Vite/Angular/electronmon-style readiness in output; use ``search_netstat_ports`` + ``kill_process``
    if the port is already in use.
    """

    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    tool_input = {'relative_project_dir': relative_project_dir, 'script_name': script_name}
    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=RUN_WORKSPACE_NODE_SMOKE_TEST_NAME,
        tool_input=tool_input,
    )
    if pending:
        return pending
    try:
        workspace_root = get_active_workspace_root()
    except ValueError as exc:
        return f'Tool error: {exc}'

    project_dir, perr, proj_label = _resolve_project_dir(workspace_root, relative_project_dir)
    if perr:
        return perr
    assert project_dir is not None
    if not (project_dir / 'package.json').is_file():
        return (
            f'Tool error: no `package.json` in project `{proj_label}`. '
            'Use `discover_npm_projects` or set `relative_project_dir`.'
        )

    script = (script_name or '').strip()
    if not script:
        script = _discover_node_smoke_script(project_dir)
    if not script:
        keys = sorted(_package_json_scripts(project_dir).keys())
        preview = ', '.join(f'`{k}`' for k in keys[:24])
        suffix = ' …' if len(keys) > 24 else ''
        return (
            'Workspace Node.js smoke test skipped:\n'
            f'- Project: `{proj_label}`\n'
            '- Reason: no smoke/dev/start/serve/preview script found in package.json.\n'
            f'- Available scripts: {preview or "(none)"}{suffix}'
        )

    gate = _package_json_script_gate(project_dir, script)
    if gate:
        return gate

    pm = detect_package_manager(project_dir)
    exe = shutil.which(pm)
    if not exe:
        return f'Tool error: `{pm}` is not on PATH; install Node.js and the package manager.'
    args = _build_run_script_args(pm, exe, script)
    command_text = ' '.join(args)
    watch_mode = argv_implies_watch_mode(args)

    await _emit_project_review_chunk(
        sid,
        f'$ {command_text}\n',
        stream_tag=_NODE_SMOKE_STREAM_TAG,
        label=_NODE_SMOKE_STREAM_LABEL,
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(project_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=with_subprocess_color_env(session_workspace_subprocess_env(session)),
        )
    except OSError as exc:
        await _emit_project_review_tool_complete(
            sid,
            stream_tag=_NODE_SMOKE_STREAM_TAG,
            label=_NODE_SMOKE_STREAM_LABEL,
            exit_code=None,
            output_excerpt='',
        )
        return f'Tool error: could not start Node smoke test ({exc}).'

    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    tracker = SmokeOutputTracker()

    def _track_output(text: str) -> None:
        tracker.feed(text)

    stdout_task = asyncio.create_task(
        _pump_subprocess_stream(
            proc.stdout,
            session_id=sid,
            emit_prefix='',
            capture_chunks=stdout_chunks,
            stream_tag=_NODE_SMOKE_STREAM_TAG,
            label=_NODE_SMOKE_STREAM_LABEL,
            on_text=_track_output,
        )
    )
    stderr_task = asyncio.create_task(
        _pump_subprocess_stream(
            proc.stderr,
            session_id=sid,
            emit_prefix='[stderr] ',
            capture_chunks=stderr_chunks,
            stream_tag=_NODE_SMOKE_STREAM_TAG,
            label=_NODE_SMOKE_STREAM_LABEL,
            on_text=_track_output,
        )
    )
    wait_task = asyncio.create_task(proc.wait())
    abort_task = asyncio.create_task(session.abort_event.wait())

    async def _emit_smoke_status(message: str) -> None:
        await _emit_project_review_chunk(
            sid,
            message,
            stream_tag=_NODE_SMOKE_STREAM_TAG,
            label=_NODE_SMOKE_STREAM_LABEL,
        )

    try:
        smoke_result = await wait_for_smoke_completion(
            proc,
            wait_task=wait_task,
            abort_task=abort_task,
            tracker=tracker,
            terminate_fn=_terminate_process,
            emit_status=_emit_smoke_status,
            watch_mode=watch_mode,
        )
    finally:
        if not abort_task.done():
            abort_task.cancel()
            try:
                await abort_task
            except asyncio.CancelledError:
                pass
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    if smoke_result.stop_reason is SmokeStopReason.ABORTED:
        replay = _stash_subprocess_output_and_replay_tail(sid, stdout_chunks, stderr_chunks)
        await _emit_project_review_tool_complete(
            sid,
            stream_tag=_NODE_SMOKE_STREAM_TAG,
            label=_NODE_SMOKE_STREAM_LABEL,
            exit_code=smoke_result.exit_code,
            output_excerpt=replay,
            outcome='failed',
        )
        return 'Aborted by user.'

    replay = _stash_subprocess_output_and_replay_tail(sid, stdout_chunks, stderr_chunks)
    await _emit_project_review_tool_complete(
        sid,
        stream_tag=_NODE_SMOKE_STREAM_TAG,
        label=_NODE_SMOKE_STREAM_LABEL,
        exit_code=smoke_result.exit_code,
        output_excerpt=replay,
        outcome='passed' if smoke_result.passed else 'failed',
    )
    return _build_node_smoke_result(
        exit_code=smoke_result.exit_code,
        project_label=proj_label,
        command_text=command_text,
        script_name=script,
        stdout_chunks=stdout_chunks,
        stderr_chunks=stderr_chunks,
        steady_state=smoke_result.steady_state,
        readiness_detected=smoke_result.readiness_detected,
        passed=smoke_result.passed,
        failure_detail=smoke_result.failure_detail,
    )


@tool(APPROVE_PROJECT_REVIEW_NAME)
def approve_project_review(summary: str = '') -> str:
    """Mark the final project review as passed."""

    sid = current_session_id.get()
    if sid:
        get_session(sid).last_project_review_subprocess_report = ''
    cleaned = (summary or '').strip()
    if cleaned:
        return f'Project review approved.\n\nSummary:\n{cleaned}'
    return 'Project review approved.'


@tool(REJECT_PROJECT_REVIEW_NAME)
def reject_project_review(feedback: str) -> str:
    """Mark the final project review as failed and return actionable feedback for a retry pass."""

    cleaned = (feedback or '').strip() or '(no details)'
    body = f'Project review rejected.\n\nReviewer feedback:\n{cleaned}'
    sid = current_session_id.get()
    if sid:
        stash = (get_session(sid).last_project_review_subprocess_report or '').strip()
        if stash:
            body += (
                '\n\nLast workspace test/smoke output:\n'
                f'{stash}'
            )
    return body


def project_review_specialist_tools() -> tuple[list[object], dict[str, object]]:
    tools: list[object] = [
        list_workspace_directory,
        retrieve_workspace_semantic,
        search_workspace,
        read_workspace_file,
        lsp_get_diagnostics,
        lsp_hover,
        lsp_find_definition,
        lsp_find_references,
        lsp_get_document_symbols,
        ensure_python_workspace_env_tool,
        install_python_packages_tool,
        install_python_requirements_file_tool,
        freeze_python_requirements_tool,
        write_frozen_python_requirements_file_tool,
        discover_npm_projects_tool,
        search_npm_packages_tool,
        install_npm_packages_tool,
        remove_npm_packages_tool,
        npm_install_project_tool,
        run_npm_script_tool,
        angular_cli_tool,
        search_netstat_ports_tool,
        kill_process_tool,
        run_workspace_python_smoke_test,
        run_workspace_node_smoke_test,
        run_workspace_pytest_tests,
        approve_project_review,
        reject_project_review,
    ]
    tool_map = {tool_obj.name: tool_obj for tool_obj in tools}
    return tools, tool_map
