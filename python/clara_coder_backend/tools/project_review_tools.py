"""Workspace verification tools (pytest) for the outer Clara agent."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from langchain_core.tools import tool

from clara_coder_backend.session.config import CLARA_SUBPROCESS_TIMEOUT_SEC
from clara_coder_backend.runtime.python_env import (
    _terminate_subprocess_tree,
    ensure_session_python_workspace_env,
    session_workspace_subprocess_env,
    with_subprocess_color_env,
)
from clara_coder_backend.hitl.deferred_tool_hitl import maybe_await_hitl_for_deferred_tool
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.chat.stream_tags import TOOL_PYTEST_STREAM_TAG
from clara_coder_backend.tools.workspace import (
    get_active_workspace_root,
    truncate_text_head_tail,
)
from clara_coder_backend.tools.tool_conventions import describe

logger = logging.getLogger('clara.project_review')

RUN_WORKSPACE_PYTEST_TESTS_NAME = 'run_workspace_pytest_tests'
_PYTEST_STREAM_TAG = TOOL_PYTEST_STREAM_TAG
_PYTEST_STREAM_LABEL = 'Workspace Pytest'
_SUBPROCESS_READ_SIZE = 65536
_TOOL_EXEC_COMPLETE_REPLAY_CHARS = 12_000


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


def _subprocess_replay_tail(stdout_chunks: list[str], stderr_chunks: list[str]) -> str:
    combined = _combined_raw_streams(stdout_chunks, stderr_chunks).strip()
    if not combined:
        return ''
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
) -> None:
    if stream is None:
        return
    while True:
        block = await stream.read(_SUBPROCESS_READ_SIZE)
        if not block:
            break
        text = block.decode('utf-8', errors='replace')
        capture_chunks.append(text)
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
    from clara_coder_backend.runtime.python_env import resolve_python_workspace_root

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


@tool(RUN_WORKSPACE_PYTEST_TESTS_NAME, description=describe(
    'Ensure workspace `.venv` exists, then run `pytest` in that environment.',
    when='final verification when a pytest suite is present.',
    not_='inventing tests during review when no suite exists (tool skips).',
    shape='runs `pytest tests -v` from the detected Python project root.',
))
async def run_workspace_pytest_tests() -> str:

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
            '- Guidance: use `run_command` for a short app/dev-server check (then `wait_for_command` / '
            '`kill_background_command`) instead of inventing tests during final review.'
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
            start_new_session=True,
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
            float(CLARA_SUBPROCESS_TIMEOUT_SEC)
            if CLARA_SUBPROCESS_TIMEOUT_SEC and CLARA_SUBPROCESS_TIMEOUT_SEC > 0
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
                replay = _subprocess_replay_tail(stdout_chunks, stderr_chunks)
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
            replay = _subprocess_replay_tail(stdout_chunks, stderr_chunks)
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
    replay = _subprocess_replay_tail(stdout_chunks, stderr_chunks)
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

