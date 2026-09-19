"""Generic shell command execution with managed background command jobs.

``run_command`` starts a shell command as a session-scoped background job and waits a
bounded window (default :data:`CLARA_RUN_COMMAND_DEFAULT_WAIT_SEC`) for it to finish.
When the command outlives the window the job stays alive and the model manages it with
``wait_for_command`` (extend the wait / collect new output), ``kill_background_command``,
and ``list_background_commands``.

**HITL** — ``run_command`` rides the deferred-tool accept-command pause
(:mod:`clara_coder_backend.tools.deferred_hitl`) when auto-apply is off; the wait/kill/list
tools only operate on jobs the user already approved, so they run without a pause.
Output is captured into a bounded rolling buffer (oldest output dropped past
:data:`_MAX_CAPTURE_CHARS`) and each report returns only output that is new since the
previous report for that job.
"""

from __future__ import annotations

import asyncio
import codecs
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Annotated

from langchain_core.tools import tool

from clara_coder_backend.config import (
    CLARA_RUN_COMMAND_DEFAULT_WAIT_SEC,
    CLARA_RUN_COMMAND_MAX_WAIT_SEC,
)
from clara_coder_backend.runtime.admin_exec import (
    ElevatedJobHandle,
    admin_elevation_supported,
    elevation_privilege_label,
    is_currently_privileged,
    shutdown_session_broker,
    start_elevated_job,
)
from clara_coder_backend.session.state import current_session_id, get_session, mutation_tools_blocked_reason
from clara_coder_backend.tools.tool_conventions import describe

RUN_COMMAND_NAME = 'run_command'
WAIT_FOR_COMMAND_NAME = 'wait_for_command'
KILL_BACKGROUND_COMMAND_NAME = 'kill_background_command'
LIST_BACKGROUND_COMMANDS_NAME = 'list_background_commands'
RUN_COMMAND_STREAM_TAG_PREFIX = 'run-command:'
_RUN_COMMAND_LABEL_MAX = 28

# Rolling capture cap per job (oldest output dropped first, like a terminal scrollback).
_MAX_CAPTURE_CHARS = 2_000_000
# Cap for the output slice embedded in a single tool report.
_MAX_REPORT_CHARS = 30_000
_MAX_RUNNING_JOBS_PER_SESSION = 8
_READ_BLOCK_BYTES = 65_536
_KILL_REPORT_TIMEOUT_SEC = 20.0
_MAX_COMMAND_CHARS = 8_192

# Structural denylist — reject before HITL / subprocess. Patterns are intentionally coarse.
# Defense-in-depth only; HITL still gates approval for non-matching commands.
_DENIED_COMMAND_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pat, re.IGNORECASE | re.DOTALL), label)
    for pat, label in (
        (r'[\n\r]', 'newline / CR command chaining'),
        (r'\$\(', 'command substitution $()'),
        (r'`', 'backtick command substitution'),
        (r'\b(env|printenv)\b', 'env dump (env/printenv)'),
        (r'\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)*(/|/\*|~|/home\b|/Users\b|/var\b|/etc\b)', 'rm -rf / (or similar)'),
        (r':\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:', 'fork bomb'),
        (r'\bdd\b[^\n]*\bof\s*=\s*/dev/', 'dd of=/dev/...'),
        (r'\bmkfs(\.\w+)?\b', 'mkfs'),
        (r'\b(shutdown|reboot|poweroff|halt)\b', 'shutdown/reboot'),
        (r'>\s*/dev/sd[a-z]\b', 'redirect to /dev/sdX'),
        (r'\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+|--recursive\s+)*777\s+/', 'chmod -R 777 /'),
        (r'\b(curl|wget)\b[\s\S]*\|\s*(ba)?sh\b', 'network download piped to shell'),
        (r'\b(ba)?sh\b[\s\S]*-c[\s\S]*\b(curl|wget)\b', 'shell -c fetching remote script'),
        (r'\bbase64\b[\s\S]*\|\s*(curl|wget|nc|ncat|netcat)\b', 'base64 pipe to network exfil'),
        (r'\b(nc|ncat|netcat)\b[^\n]*\s+-e\s+', 'netcat exec (-e)'),
        (r'\bcurl\b[^\n]*\s(--data|-d|--upload-file|-T)\b[^\n]*(/etc/passwd|/etc/shadow|\.ssh/)', 'credential exfil via curl'),
    )
)


def validate_run_command_text(command: str) -> str | None:
    """Return an error string if ``command`` is too long or matches a denylist pattern."""
    text = (command or '').strip()
    if not text:
        return 'Tool error: `command` must not be empty.'
    if len(text) > _MAX_COMMAND_CHARS:
        return f'Tool error: `command` is too long (max {_MAX_COMMAND_CHARS} characters).'
    for pattern, label in _DENIED_COMMAND_PATTERNS:
        if pattern.search(text):
            return f'Tool error: command blocked by safety policy ({label}).'
    return None

STATUS_RUNNING = 'running'
STATUS_EXITED = 'exited'
STATUS_KILLED = 'killed'

__all__ = [
    'KILL_BACKGROUND_COMMAND_NAME',
    'LIST_BACKGROUND_COMMANDS_NAME',
    'RUN_COMMAND_NAME',
    'RUN_COMMAND_STREAM_TAG_PREFIX',
    'WAIT_FOR_COMMAND_NAME',
    'background_command_jobs',
    'background_command_tools',
    'handle_background_command_terminal_closed',
    'kill_background_command_tool',
    'kill_session_background_commands',
    'list_background_commands_tool',
    'normalize_run_command_elevation',
    'run_command_tool',
    'wait_for_command_tool',
]


_LEADING_SUDO_VALUE_FLAGS = frozenset({'-u', '-g', '-C', '-D', '-p', '-r', '-t', '-U'})


def normalize_run_command_elevation(command: str, elevate: bool = False) -> tuple[str, bool]:
    """Strip a leading ``sudo`` (and common flags) and return ``(command, elevate)``."""

    text = (command or '').strip()
    tokens = text.split()
    if tokens and tokens[0].lower() == 'sudo':
        index = 1
        while index < len(tokens):
            token = tokens[index]
            if token == '--':
                index += 1
                break
            if token in _LEADING_SUDO_VALUE_FLAGS:
                index += 2
                continue
            if token.startswith('-'):
                index += 1
                continue
            break
        return ' '.join(tokens[index:]), True
    return text, bool(elevate)


@dataclass
class CommandJob:
    """One spawned shell command and its rolling output buffer."""

    job_id: str
    session_id: str
    command_text: str
    cwd_label: str
    proc: asyncio.subprocess.Process | None
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
    elevated: bool = False
    elevated_handle: ElevatedJobHandle | None = None

    def elapsed_sec(self) -> int:
        return max(0, int(time.monotonic() - self.started_at))


_JOBS: dict[str, CommandJob] = {}


def background_command_jobs() -> dict[str, CommandJob]:
    """Live job registry (exposed for tests and session cleanup)."""
    return _JOBS


def _run_command_stream_tag(command_id: str) -> str:
    return f'{RUN_COMMAND_STREAM_TAG_PREFIX}{command_id}'


def _run_command_tab_label(command_text: str) -> str:
    text = (command_text or '').strip().replace('\n', ' ')
    if len(text) <= _RUN_COMMAND_LABEL_MAX:
        return text or RUN_COMMAND_NAME
    return text[: _RUN_COMMAND_LABEL_MAX - 1] + '…'


async def _emit_run_command_nested(
    session_id: str,
    stream_tag: str,
    event: str,
    data: dict[str, object],
) -> None:
    session = get_session(session_id)
    queue = session.planning_nested_events_q
    if queue is None:
        return
    await queue.put((stream_tag, {'event': event, 'data': data}))


async def _emit_run_command_chunk(session_id: str, job: CommandJob, delta: str) -> None:
    if not delta:
        return
    await _emit_run_command_nested(
        session_id,
        _run_command_stream_tag(job.job_id),
        'tool_exec_chunk',
        {
            'delta': delta,
            'stream_tag': _run_command_stream_tag(job.job_id),
            'label': _run_command_tab_label(job.command_text),
        },
    )


async def _emit_run_command_open(session_id: str, job: CommandJob) -> None:
    label = _run_command_tab_label(job.command_text)
    stream_tag = _run_command_stream_tag(job.job_id)
    await _emit_run_command_nested(
        session_id,
        stream_tag,
        'background_command_open',
        {
            'command_id': job.job_id,
            'command_text': job.command_text,
            'cwd_label': job.cwd_label,
            'label': label,
            'stream_tag': stream_tag,
        },
    )


async def _emit_run_command_complete(session_id: str, job: CommandJob) -> None:
    label = _run_command_tab_label(job.command_text)
    stream_tag = _run_command_stream_tag(job.job_id)
    await _emit_run_command_nested(
        session_id,
        stream_tag,
        'tool_exec_complete',
        {
            'stream_tag': stream_tag,
            'label': label,
            'exit_code': job.exit_code,
        },
    )


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
    try:
        handle = job.elevated_handle
        if handle is not None:
            async for block in handle.iter_chunks():
                chunk = decoder.decode(block)
                _append_output(job, chunk)
                await _emit_run_command_chunk(job.session_id, job, chunk)
            tail = decoder.decode(b'', True)
            _append_output(job, tail)
            await _emit_run_command_chunk(job.session_id, job, tail)
        else:
            stdout = job.proc.stdout if job.proc is not None else None
            if stdout is not None:
                while True:
                    block = await stdout.read(_READ_BLOCK_BYTES)
                    if not block:
                        break
                    chunk = decoder.decode(block)
                    _append_output(job, chunk)
                    await _emit_run_command_chunk(job.session_id, job, chunk)
                tail = decoder.decode(b'', True)
                _append_output(job, tail)
                await _emit_run_command_chunk(job.session_id, job, tail)
    finally:
        if job.elevated_handle is not None:
            code = await job.elevated_handle.wait()
        elif job.proc is not None:
            code = await job.proc.wait()
        else:
            code = 1
        job.exit_code = code
        if job.status == STATUS_RUNNING:
            job.status = STATUS_EXITED
        job.done.set()
        await _emit_run_command_complete(job.session_id, job)


def _normalize_wait_seconds(wait_seconds: object, *, default: float) -> tuple[float | None, str | None]:
    if wait_seconds is None:
        return float(default), None
    if isinstance(wait_seconds, bool) or not isinstance(wait_seconds, (int, float)):
        return None, 'Tool error: `wait_seconds` must be a number.'
    value = float(wait_seconds)
    if value < 0:
        return None, 'Tool error: `wait_seconds` must be zero or positive.'
    return min(value, float(CLARA_RUN_COMMAND_MAX_WAIT_SEC)), None


def _truncate_report_output(text: str) -> str:
    from clara_coder_backend.tools.workspace import truncate_text_head_tail

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
    if job.elevated:
        lines.append(f'- Elevation: `{elevation_privilege_label()}`')
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
    from clara_coder_backend.runtime.python_env import _terminate_subprocess_tree

    if job.status == STATUS_RUNNING:
        job.status = STATUS_KILLED
    if job.elevated_handle is not None:
        await job.elevated_handle.kill()
        return
    if job.proc is not None:
        await _terminate_subprocess_tree(job.proc)


async def _start_job(
    session_id: str,
    *,
    command: str,
    cwd_label: str,
    cwd: str,
    env: dict[str, str] | None,
    elevated: bool = False,
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
        elevated=elevated,
    )
    job.reader_task = asyncio.create_task(_pump_output(job))
    _JOBS[job.job_id] = job
    await _emit_run_command_open(session_id, job)
    return job, None


async def _start_elevated_job(
    session_id: str,
    *,
    command: str,
    cwd_label: str,
    cwd: str,
    env: dict[str, str] | None,
    persist: bool,
) -> tuple[CommandJob | None, str | None]:
    if not admin_elevation_supported():
        return None, 'Tool error: admin commands are supported on Windows and Linux only.'
    if is_currently_privileged():
        return await _start_job(
            session_id,
            command=command,
            cwd_label=cwd_label,
            cwd=cwd,
            env=env,
            elevated=True,
        )
    job_id = uuid.uuid4().hex[:8]
    handle, err = await start_elevated_job(
        session_id,
        job_id=job_id,
        command=command,
        cwd=cwd,
        env=env,
        persist=persist,
    )
    if err or handle is None:
        return None, err or 'Tool error: elevated command failed to start.'
    job = CommandJob(
        job_id=job_id,
        session_id=session_id,
        command_text=command,
        cwd_label=cwd_label,
        proc=None,
        started_at=time.monotonic(),
        elevated=True,
        elevated_handle=handle,
    )
    job.reader_task = asyncio.create_task(_pump_output(job))
    _JOBS[job.job_id] = job
    await _emit_run_command_open(session_id, job)
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
    when=(
        'builds, tests, git, scripts, app/runtime smoke checks, and long-lived dev servers '
        '(npm/pnpm/yarn start/dev/serve/preview, python entrypoints) — anything without a dedicated tool. '
        'Set `elevate` for package installs, services, hosts/firewall, and other admin/root work.'
    ),
    not_=(
        'interactive commands (stdin is closed; no password prompt); '
        'use `kill_background_command` for jobs started here.'
    ),
    shape=(
        'requires user confirmation unless auto-apply is on; `elevate=true` without Admin '
        'asks the user to grant administrator access (same HITL as the composer Admin chip); '
        'after Admin is on, auto-apply off still asks Run/Cancel; '
        'waits `wait_seconds` '
        f'(default {CLARA_RUN_COMMAND_DEFAULT_WAIT_SEC}s, 0 = return immediately, max {CLARA_RUN_COMMAND_MAX_WAIT_SEC}s); '
        'if still running, returns a command id for `wait_for_command` / `kill_background_command`; '
        'prefer this over one-shot runners for servers so the process stays in the background framework; '
        'stdout+stderr merged; `cwd` is workspace-relative; a leading `sudo` is treated as `elevate`.'
    ),))
async def run_command_tool(
    command: Annotated[str, 'shell command line, e.g. `npm run build`'],
    cwd: Annotated[str, 'workspace-relative working directory (empty = workspace root)'] = '',
    wait_seconds: Annotated[float | None, 'seconds to wait before reporting; 0 = fire and forget'] = None,
    elevate: Annotated[bool, 'run with administrator/root privileges; user must enable Admin in the composer first'] = False,
) -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)

    if isinstance(elevate, str):
        elevate = elevate.strip().lower() in {'1', 'true', 'yes', 'on'}
    else:
        elevate = bool(elevate)
    command_text, elevate = normalize_run_command_elevation(command, elevate)
    denied = validate_run_command_text(command_text)
    if denied:
        return denied
    if elevate and not admin_elevation_supported():
        return 'Tool error: admin commands are supported on Windows and Linux only.'
    wait_sec, wait_err = _normalize_wait_seconds(wait_seconds, default=CLARA_RUN_COMMAND_DEFAULT_WAIT_SEC)
    if wait_err:
        return wait_err
    assert wait_sec is not None
    if elevate and not session.admin_elevation_granted:
        from clara_coder_backend.tools.deferred_hitl import (
            deferred_tool_hitl_bypass,
            maybe_await_hitl_for_admin_elevation,
        )

        if deferred_tool_hitl_bypass.get():
            return (
                'Tool error: administrator access is off. The user must enable Admin in the composer '
                '(shield chip) before elevated `run_command` / `sudo` can run.'
            )
        return maybe_await_hitl_for_admin_elevation(
            session,
            tool_name=RUN_COMMAND_NAME,
            tool_input={
                'command': command_text,
                'cwd': cwd,
                'wait_seconds': wait_sec,
                'elevate': True,
            },
        )

    from clara_coder_backend.tools.deferred_hitl import maybe_await_hitl_for_deferred_tool

    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=RUN_COMMAND_NAME,
        tool_input={
            'command': command_text,
            'cwd': cwd,
            'wait_seconds': wait_sec,
            'elevate': elevate,
        },
    )
    if pending:
        return pending

    # Re-check after HITL in case the approved payload was mutated somehow.
    denied_after = validate_run_command_text(command_text)
    if denied_after:
        return denied_after

    from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path

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

    from clara_coder_backend.runtime.python_env import session_workspace_subprocess_env, with_subprocess_color_env

    env = session_workspace_subprocess_env(session) or with_subprocess_color_env()
    if elevate:
        job, start_err = await _start_elevated_job(
            sid,
            command=command_text,
            cwd_label=cwd_label,
            cwd=str(cwd_path),
            env=env,
            persist=bool(session.admin_elevation_granted),
        )
    else:
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
        f'waits up to `wait_seconds` (default {CLARA_RUN_COMMAND_DEFAULT_WAIT_SEC}s, 0 = status check only, '
        f'max {CLARA_RUN_COMMAND_MAX_WAIT_SEC}s); returns only output new since the last report; '
        'callable repeatedly.'
    ),))
async def wait_for_command_tool(
    command_id: Annotated[str, 'id returned by run_command'],
    wait_seconds: Annotated[float | None, 'extra seconds to wait; 0 = just report current status'] = None,
) -> str:

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    wait_sec, wait_err = _normalize_wait_seconds(wait_seconds, default=CLARA_RUN_COMMAND_DEFAULT_WAIT_SEC)
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
    not_='host processes not started by `run_command` (kill those outside this tool surface).',
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


async def handle_background_command_terminal_closed(session_id: str, command_id: str) -> tuple[bool, str]:
    """Kill a background command when the user closes its terminal tab; queue an agent note."""
    from clara_coder_backend.session.user_events import queue_user_event_note

    sid = (session_id or '').strip()
    cleaned = (command_id or '').strip()
    if not sid:
        return False, 'Missing session_id.'
    if not cleaned:
        return False, 'Missing command_id.'

    session = get_session(sid)
    job, find_err = _find_session_job(sid, cleaned)
    if find_err:
        note = (
            f'User closed the terminal tab for background command `{cleaned or "(empty)"}`, '
            'but that command is no longer tracked in this session (it may have already exited).'
        )
        queue_user_event_note(session, note)
        return True, note

    assert job is not None
    was_running = job.status == STATUS_RUNNING
    if was_running:
        await _kill_job(job)
        try:
            await asyncio.wait_for(job.done.wait(), timeout=_KILL_REPORT_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            pass
    if job.status == STATUS_KILLED:
        status = f'killed (exit code {job.exit_code})' if job.exit_code is not None else 'killed'
    elif job.status == STATUS_EXITED:
        status = f'exited with code {job.exit_code}'
    else:
        status = 'still running'
    note = (
        f'User closed the terminal tab for background command `{job.job_id}` (`{job.command_text}`). '
        f'The command was {"terminated" if was_running else "already finished"} ({status}).'
    )
    queue_user_event_note(session, note)
    if job.status != STATUS_RUNNING:
        _JOBS.pop(job.job_id, None)
    return True, note


async def kill_session_background_commands(session_id: str) -> None:
    """Terminate and drop every job for a session (used when the session is cleared)."""
    for job_id, job in list(_JOBS.items()):
        if job.session_id != session_id:
            continue
        if job.status == STATUS_RUNNING:
            await _kill_job(job)
        _JOBS.pop(job_id, None)
    await shutdown_session_broker(session_id)


def background_command_tools() -> list[object]:
    return [
        run_command_tool,
        wait_for_command_tool,
        kill_background_command_tool,
        list_background_commands_tool,
    ]
