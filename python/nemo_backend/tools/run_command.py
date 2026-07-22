"""Generic shell command execution with managed background command jobs.

``run_command`` starts a shell command as a session-scoped background job and waits a
bounded window (default :data:`NEMO_RUN_COMMAND_DEFAULT_WAIT_SEC`) for it to finish.
When the command outlives the window the job stays alive and the model manages it with
``wait_for_command`` (extend the wait / collect new output), ``kill_background_command``,
and ``list_background_commands``.

**HITL** — ``run_command`` rides the deferred-tool accept-command pause
(:mod:`nemo_backend.deferred_tool_hitl`) when auto-apply is off; the wait/kill/list
tools only operate on jobs the user already approved, so they run without a pause.
Output is captured into a bounded rolling buffer (oldest output dropped past
:data:`_MAX_CAPTURE_CHARS`) and each report returns only output that is new since the
previous report for that job.
"""

from __future__ import annotations

import asyncio
import codecs
import time
import uuid
from dataclasses import dataclass, field
from typing import Annotated

from langchain_core.tools import tool

from nemo_backend.config import (
    NEMO_RUN_COMMAND_DEFAULT_WAIT_SEC,
    NEMO_RUN_COMMAND_MAX_WAIT_SEC,
)
from nemo_backend.state import current_session_id, get_session, mutation_tools_blocked_reason
from nemo_backend.tools.tool_conventions import describe

RUN_COMMAND_NAME = 'run_command'
WAIT_FOR_COMMAND_NAME = 'wait_for_command'
KILL_BACKGROUND_COMMAND_NAME = 'kill_background_command'
LIST_BACKGROUND_COMMANDS_NAME = 'list_background_commands'

# Rolling capture cap per job (oldest output dropped first, like a terminal scrollback).
_MAX_CAPTURE_CHARS = 2_000_000
# Cap for the output slice embedded in a single tool report.
_MAX_REPORT_CHARS = 30_000
_MAX_RUNNING_JOBS_PER_SESSION = 8
_READ_BLOCK_BYTES = 65_536
_KILL_REPORT_TIMEOUT_SEC = 20.0

STATUS_RUNNING = 'running'
STATUS_EXITED = 'exited'
STATUS_KILLED = 'killed'

__all__ = [
    'KILL_BACKGROUND_COMMAND_NAME',
    'LIST_BACKGROUND_COMMANDS_NAME',
    'RUN_COMMAND_NAME',
    'WAIT_FOR_COMMAND_NAME',
    'background_command_jobs',
    'background_command_tools',
    'kill_background_command_tool',
    'kill_session_background_commands',
    'list_background_commands_tool',
    'run_command_tool',
    'wait_for_command_tool',
]


@dataclass
class CommandJob:
    """One spawned shell command and its rolling output buffer."""

    job_id: str
    session_id: str
    command_text: str
    cwd_label: str
    proc: asyncio.subprocess.Process
    started_at: float  # time.monotonic()
    buffer: str = ''
    #: Absolute char index of ``buffer[0]`` in the full output stream (grows when old output is dropped).
    buffer_start: int = 0
    #: Absolute char index up to which output was already reported to the model.
    read_offset: int = 0
    status: str = STATUS_RUNNING
    exit_code: int | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)
    reader_task: asyncio.Task | None = None

    def elapsed_sec(self) -> int:
        return max(0, int(time.monotonic() - self.started_at))


_JOBS: dict[str, CommandJob] = {}


def background_command_jobs() -> dict[str, CommandJob]:
    """Live job registry (exposed for tests and session cleanup)."""
    return _JOBS


def _append_output(job: CommandJob, text: str) -> None:
    if not text:
        return
    job.buffer += text
    overflow = len(job.buffer) - _MAX_CAPTURE_CHARS
    if overflow > 0:
        job.buffer = job.buffer[overflow:]
        job.buffer_start += overflow


def _consume_new_output(job: CommandJob) -> tuple[str, bool]:
    """Return output since the last report and whether some of it was already dropped."""
    dropped = job.read_offset < job.buffer_start
    start = max(job.read_offset - job.buffer_start, 0)
    text = job.buffer[start:]
    job.read_offset = job.buffer_start + len(job.buffer)
    return text, dropped


async def _pump_output(job: CommandJob) -> None:
    """Stream merged stdout+stderr into the rolling buffer, then record the exit."""
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    stdout = job.proc.stdout
    try:
        if stdout is not None:
            while True:
                block = await stdout.read(_READ_BLOCK_BYTES)
                if not block:
                    break
                _append_output(job, decoder.decode(block))
            _append_output(job, decoder.decode(b'', True))
    finally:
        code = await job.proc.wait()
        job.exit_code = code
        if job.status == STATUS_RUNNING:
            job.status = STATUS_EXITED
        job.done.set()


def _normalize_wait_seconds(wait_seconds: object, *, default: float) -> tuple[float | None, str | None]:
    if wait_seconds is None:
        return float(default), None
    if isinstance(wait_seconds, bool) or not isinstance(wait_seconds, (int, float)):
        return None, 'Tool error: `wait_seconds` must be a number.'
    value = float(wait_seconds)
    if value < 0:
        return None, 'Tool error: `wait_seconds` must be zero or positive.'
    return min(value, float(NEMO_RUN_COMMAND_MAX_WAIT_SEC)), None


def _truncate_report_output(text: str) -> str:
    from nemo_backend.tools.workspace import truncate_text_head_tail

    return truncate_text_head_tail(text, _MAX_REPORT_CHARS)


def _running_session_jobs(session_id: str) -> list[CommandJob]:
    return [job for job in _JOBS.values() if job.session_id == session_id and job.status == STATUS_RUNNING]


def _format_report(job: CommandJob, *, waited_sec: float) -> str:
    new_output, dropped = _consume_new_output(job)
    lines = [
        'Command report:',
        f'- Command id: `{job.job_id}`',
        f'- Command: `{job.command_text}`',
        f'- Working directory: `{job.cwd_label}`',
    ]
    if job.status == STATUS_RUNNING:
        lines.append(f'- Status: still running after {job.elapsed_sec()}s (waited {int(waited_sec)}s this call)')
    elif job.status == STATUS_KILLED:
        lines.append(f'- Status: killed after {job.elapsed_sec()}s')
    else:
        lines.append(f'- Status: exited with code {job.exit_code} after {job.elapsed_sec()}s')
    if dropped:
        lines.append(f'- Note: older output beyond the {_MAX_CAPTURE_CHARS}-char capture buffer was dropped.')
    lines.append('')
    if new_output.strip():
        lines.append('New output:')
        lines.append(_truncate_report_output(new_output).rstrip())
    else:
        lines.append('New output: (none)')
    if job.status == STATUS_RUNNING:
        lines.append('')
        lines.append(
            f'Next: `{WAIT_FOR_COMMAND_NAME}` with command_id `{job.job_id}` to keep waiting, '
            f'`{KILL_BACKGROUND_COMMAND_NAME}` to stop it, or leave it running (e.g. dev servers) '
            'and continue with other work.'
        )
    return '\n'.join(lines) + '\n'


async def _wait_and_report(job: CommandJob, wait_sec: float) -> str:
    started = time.monotonic()
    if wait_sec > 0 and not job.done.is_set():
        try:
            await asyncio.wait_for(asyncio.shield(job.done.wait()), timeout=wait_sec)
        except asyncio.TimeoutError:
            pass
    report = _format_report(job, waited_sec=time.monotonic() - started)
    if job.status != STATUS_RUNNING:
        _JOBS.pop(job.job_id, None)
    return report


async def _kill_job(job: CommandJob) -> None:
    from nemo_backend.python_env import _terminate_subprocess_tree

    if job.status == STATUS_RUNNING:
        job.status = STATUS_KILLED
    await _terminate_subprocess_tree(job.proc)


async def _start_job(
    session_id: str,
    *,
    command: str,
    cwd_label: str,
    cwd: str,
    env: dict[str, str] | None,
) -> tuple[CommandJob | None, str | None]:
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as exc:
        return None, f'Tool error: command failed to start: {exc}'
    job = CommandJob(
        job_id=uuid.uuid4().hex[:8],
        session_id=session_id,
        command_text=command,
        cwd_label=cwd_label,
        proc=proc,
        started_at=time.monotonic(),
    )
    job.reader_task = asyncio.create_task(_pump_output(job))
    _JOBS[job.job_id] = job
    return job, None


def _find_session_job(session_id: str, command_id: str) -> tuple[CommandJob | None, str | None]:
    cleaned = (command_id or '').strip()
    job = _JOBS.get(cleaned)
    if job is None or job.session_id != session_id:
        running = _running_session_jobs(session_id)
        hint = (
            f' Running commands: {", ".join(f"`{j.job_id}`" for j in running)}.'
            if running
            else ' No background commands are running in this session.'
        )
        return None, f'Tool error: no background command with id `{cleaned or "(empty)"}`.{hint}'
    return job, None


@tool(RUN_COMMAND_NAME, description=describe(
    'Run a shell command in the workspace as a managed background job.',
    when='builds, tests, git, scripts, dev servers — anything without a dedicated tool.',
    not_='interactive commands (stdin is closed); killing host processes by PID (use `kill_process`).',
    shape=(
        'requires user confirmation unless auto-apply is on; waits `wait_seconds` '
        f'(default {NEMO_RUN_COMMAND_DEFAULT_WAIT_SEC}s, 0 = return immediately, max {NEMO_RUN_COMMAND_MAX_WAIT_SEC}s); '
        'if still running, returns a command id for `wait_for_command` / `kill_background_command`; '
        'stdout+stderr merged; `cwd` is workspace-relative.'
    ),))
async def run_command_tool(
    command: Annotated[str, 'shell command line, e.g. `npm run build`'],
    cwd: Annotated[str, 'workspace-relative working directory (empty = workspace root)'] = '',
    wait_seconds: Annotated[float | None, 'seconds to wait before reporting; 0 = fire and forget'] = None,
) -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)

    command_text = (command or '').strip()
    if not command_text:
        return 'Tool error: `command` must not be empty.'
    wait_sec, wait_err = _normalize_wait_seconds(wait_seconds, default=NEMO_RUN_COMMAND_DEFAULT_WAIT_SEC)
    if wait_err:
        return wait_err
    assert wait_sec is not None

    from nemo_backend.deferred_tool_hitl import maybe_await_hitl_for_deferred_tool

    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=RUN_COMMAND_NAME,
        tool_input={'command': command_text, 'cwd': cwd, 'wait_seconds': wait_sec},
    )
    if pending:
        return pending

    from nemo_backend.tools.workspace import get_active_workspace_root, normalize_relative_path

    try:
        workspace_root = get_active_workspace_root()
        cwd_path = normalize_relative_path(workspace_root, cwd or '.')
    except ValueError as exc:
        return f'Tool error: {exc}'
    if not cwd_path.is_dir():
        return f'Tool error: working directory `{cwd.strip() or "."}` does not exist in the workspace.'
    cwd_label = cwd.strip().replace('\\', '/') or '.'

    running = _running_session_jobs(sid)
    if len(running) >= _MAX_RUNNING_JOBS_PER_SESSION:
        listing = ', '.join(f'`{job.job_id}` ({job.command_text})' for job in running)
        return (
            f'Tool error: {_MAX_RUNNING_JOBS_PER_SESSION} background commands are already running: {listing}. '
            f'Finish or `{KILL_BACKGROUND_COMMAND_NAME}` one first.'
        )

    from nemo_backend.python_env import session_workspace_subprocess_env, with_subprocess_color_env

    env = session_workspace_subprocess_env(session) or with_subprocess_color_env()
    job, start_err = await _start_job(
        sid,
        command=command_text,
        cwd_label=cwd_label,
        cwd=str(cwd_path),
        env=env,
    )
    if start_err:
        return start_err
    assert job is not None
    return await _wait_and_report(job, wait_sec)


@tool(WAIT_FOR_COMMAND_NAME, description=describe(
    'Wait longer on a running background command and collect its new output.',
    when=f'`{RUN_COMMAND_NAME}` reported a command as still running and you need its result or logs.',
    not_='starting commands (use `run_command`).',
    shape=(
        f'waits up to `wait_seconds` (default {NEMO_RUN_COMMAND_DEFAULT_WAIT_SEC}s, 0 = status check only, '
        f'max {NEMO_RUN_COMMAND_MAX_WAIT_SEC}s); returns only output new since the last report; '
        'callable repeatedly.'
    ),))
async def wait_for_command_tool(
    command_id: Annotated[str, 'id returned by run_command'],
    wait_seconds: Annotated[float | None, 'extra seconds to wait; 0 = just report current status'] = None,
) -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    wait_sec, wait_err = _normalize_wait_seconds(wait_seconds, default=NEMO_RUN_COMMAND_DEFAULT_WAIT_SEC)
    if wait_err:
        return wait_err
    assert wait_sec is not None
    job, find_err = _find_session_job(sid, command_id)
    if find_err:
        return find_err
    assert job is not None
    return await _wait_and_report(job, wait_sec)


@tool(KILL_BACKGROUND_COMMAND_NAME, description=describe(
    'Stop a background command started by `run_command` (terminates the whole process tree).',
    when='a command hangs, loops, or a dev server is no longer needed.',
    not_='host processes not started by `run_command` (use `kill_process`).',
    shape='no confirmation needed (the command was already user-approved); returns the final output.',))
async def kill_background_command_tool(
    command_id: Annotated[str, 'id returned by run_command'],
) -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    job, find_err = _find_session_job(sid, command_id)
    if find_err:
        return find_err
    assert job is not None
    if job.status == STATUS_RUNNING:
        await _kill_job(job)
    return await _wait_and_report(job, _KILL_REPORT_TIMEOUT_SEC)


@tool(LIST_BACKGROUND_COMMANDS_NAME, description=describe(
    'List background commands started by `run_command` in this session.',
    when='recovering a lost command id or checking what is still running.',
    shape='read-only; shows id, status, elapsed time, and command line.',))
async def list_background_commands_tool() -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    jobs = [job for job in _JOBS.values() if job.session_id == sid]
    if not jobs:
        return 'No background commands in this session.'
    lines = ['Background commands:']
    for index, job in enumerate(sorted(jobs, key=lambda j: j.started_at), start=1):
        if job.status == STATUS_RUNNING:
            status = f'running ({job.elapsed_sec()}s)'
        elif job.status == STATUS_KILLED:
            status = 'killed'
        else:
            status = f'exited (code {job.exit_code})'
        command_preview = job.command_text if len(job.command_text) <= 80 else job.command_text[:77] + '...'
        lines.append(f'{index}. `{job.job_id}` — {status} — `{command_preview}` (cwd `{job.cwd_label}`)')
    return '\n'.join(lines) + '\n'


async def kill_session_background_commands(session_id: str) -> None:
    """Terminate and drop every job for a session (used when the session is cleared)."""
    for job_id, job in list(_JOBS.items()):
        if job.session_id != session_id:
            continue
        if job.status == STATUS_RUNNING:
            await _kill_job(job)
        _JOBS.pop(job_id, None)


def background_command_tools() -> list[object]:
    return [
        run_command_tool,
        wait_for_command_tool,
        kill_background_command_tool,
        list_background_commands_tool,
    ]
