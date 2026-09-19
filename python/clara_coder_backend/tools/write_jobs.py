"""Session-scoped staging write jobs (start / wait / cancel / list).

Write-through staging can block on Black, Prettier, or LSP sync. The stage_* tools start a
background job, wait a bounded window, and return a write id when the work is still
running. A second stage on the same path reuses that job instead of starting another write.

**HITL** — ``land_in_workspace`` is applied only by the tool that observes completion
(the original ``stage_*`` call or ``wait_for_write``), so diff-review pause still wraps
the current tool call.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Callable

from langchain_core.tools import tool

from clara_coder_backend.config import (
    CLARA_WRITE_JOB_DEFAULT_WAIT_SEC,
    CLARA_WRITE_JOB_MAX_WAIT_SEC,
    CLARA_WRITE_JOB_TIMEOUT_SEC,
)
from clara_coder_backend.session.state import current_session_id, get_session, mutation_tools_blocked_reason
from clara_coder_backend.tools.tool_conventions import describe

logger = logging.getLogger('clara.write_jobs')

WAIT_FOR_WRITE_NAME = 'wait_for_write'
CANCEL_WRITE_NAME = 'cancel_write'
LIST_WRITE_JOBS_NAME = 'list_write_jobs'

PHASE_WRITING = 'writing'
PHASE_FORMATTING = 'formatting'
PHASE_LSP = 'lsp'
PHASE_DONE = 'done'
PHASE_FAILED = 'failed'
PHASE_CANCELLED = 'cancelled'

STATUS_RUNNING = 'running'
STATUS_DONE = 'done'
STATUS_FAILED = 'failed'
STATUS_CANCELLED = 'cancelled'

#: Short UI wording per in-flight phase (shown as the tool pill detail while the job runs).
PHASE_UI_LABELS: dict[str, str] = {
    PHASE_WRITING: 'writing to disk',
    PHASE_FORMATTING: 'formatting',
    PHASE_LSP: 'checking diagnostics',
}

WriteJobRunner = Callable[['WriteJob'], str]


def write_job_phase_detail(rel_display: str, phase: str) -> str:
    """Tool pill detail for a running write job, e.g. ``src/app.ts · formatting``."""
    label = PHASE_UI_LABELS.get(phase, phase)
    return f'{rel_display} · {label}' if rel_display else label


def publish_write_job_phase(job: 'WriteJob') -> None:
    """Post the job's current phase to the outer SSE stream (safe to call from the worker thread).

    Uses the session's ``planning_nested_events_q`` via ``call_soon_threadsafe``; the outer
    graph loop folds it into the running tool pill (see ``tool_progress`` in ``langgraph_sse``).
    No-op when no stream is attached (tests, sync fallback).
    """
    try:
        session = get_session(job.session_id)
    except Exception:
        return
    queue = getattr(session, 'planning_nested_events_q', None)
    loop = getattr(session, 'planning_nested_events_loop', None)
    if queue is None or loop is None or loop.is_closed():
        return
    item = (
        'tool-progress',
        {
            'event': 'tool_progress',
            'data': {
                'tool_name': job.tool_name,
                'relative_path': job.rel_display,
                'detail': write_job_phase_detail(job.rel_display, job.phase),
            },
        },
    )
    try:
        loop.call_soon_threadsafe(queue.put_nowait, item)
    except RuntimeError:
        # Loop shut down between the check and the call; progress is best-effort.
        pass


@dataclass
class WriteJob:
    """One in-flight (or recently finished) staging write."""

    job_id: str
    session_id: str
    rel_display: str
    tool_name: str
    land_in_workspace: bool
    started_at: float
    runner: WriteJobRunner
    payload: dict[str, Any] = field(default_factory=dict)
    phase: str = PHASE_WRITING
    status: str = STATUS_RUNNING
    result_text: str = ''
    extra_footer: str = ''
    error_text: str = ''
    temp_path: str = ''
    cancel_requested: bool = False
    committed: bool = False
    land_applied: bool = False
    commit_lock: threading.Lock = field(default_factory=threading.Lock)
    done_thread: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None

    def elapsed_sec(self) -> int:
        return max(0, int(time.monotonic() - self.started_at))

    def set_phase(self, phase: str) -> None:
        """Advance the in-flight phase and surface it on the tool pill."""
        self.phase = phase
        if self.status == STATUS_RUNNING:
            publish_write_job_phase(self)


_JOBS: dict[str, WriteJob] = {}
_PATH_RUNNING: dict[tuple[str, str], str] = {}
_LOCK = threading.Lock()


def write_jobs() -> dict[str, WriteJob]:
    """Live job registry (tests and session cleanup)."""
    return _JOBS


def _path_key(session_id: str, rel_display: str) -> tuple[str, str]:
    return session_id, rel_display.strip().replace('\\', '/')


def running_write_for_path(session_id: str, rel_display: str) -> WriteJob | None:
    """Return the in-flight write for ``rel_display`` in this session, if any."""
    with _LOCK:
        job_id = _PATH_RUNNING.get(_path_key(session_id, rel_display))
        if not job_id:
            return None
        job = _JOBS.get(job_id)
        if job is None or job.status != STATUS_RUNNING:
            return None
        return job


def _running_session_jobs(session_id: str) -> list[WriteJob]:
    return [job for job in _JOBS.values() if job.session_id == session_id and job.status == STATUS_RUNNING]


def _normalize_wait_seconds(wait_seconds: object, *, default: float) -> tuple[float | None, str | None]:
    if wait_seconds is None:
        return float(default), None
    if isinstance(wait_seconds, bool) or not isinstance(wait_seconds, (int, float)):
        return None, 'Tool error: `wait_seconds` must be a number.'
    value = float(wait_seconds)
    if value < 0:
        return None, 'Tool error: `wait_seconds` must be zero or positive.'
    return min(value, float(CLARA_WRITE_JOB_MAX_WAIT_SEC)), None


def _cleanup_temp(job: WriteJob) -> None:
    """Unlink the in-progress temp only when the draft was never committed."""
    if job.committed:
        return
    raw = (job.temp_path or '').strip()
    if not raw:
        return
    from clara_coder_backend.staging.edit_staging import unlink_staging_quiet

    unlink_staging_quiet(Path(raw))
    job.temp_path = ''


def _release_path_lock(job: WriteJob) -> None:
    with _LOCK:
        key = _path_key(job.session_id, job.rel_display)
        if _PATH_RUNNING.get(key) == job.job_id:
            _PATH_RUNNING.pop(key, None)


def _drop_job(job: WriteJob) -> None:
    _release_path_lock(job)
    with _LOCK:
        _JOBS.pop(job.job_id, None)


def _run_job_thread(job: WriteJob) -> None:
    timed_out = threading.Event()

    def body() -> None:
        try:
            text = job.runner(job)
        except Exception as exc:
            if job.cancel_requested or timed_out.is_set():
                job.status = STATUS_CANCELLED if job.cancel_requested else STATUS_FAILED
                job.phase = PHASE_CANCELLED if job.cancel_requested else PHASE_FAILED
                if not job.error_text:
                    job.error_text = (
                        f'Tool error: write job timed out after {CLARA_WRITE_JOB_TIMEOUT_SEC}s.'
                        if timed_out.is_set()
                        else f'Tool error: write job failed ({exc}).'
                    )
                _cleanup_temp(job)
                return
            logger.warning('write job failed id=%s path=%s err=%s', job.job_id, job.rel_display, exc)
            job.status = STATUS_FAILED
            job.phase = PHASE_FAILED
            job.error_text = f'Tool error: write job failed ({exc}).'
            _cleanup_temp(job)
            return
        if job.committed:
            if isinstance(text, str) and not text.startswith('Tool error:'):
                job.result_text = text
            job.status = STATUS_DONE
            job.phase = PHASE_DONE
            return
        if job.cancel_requested or timed_out.is_set():
            job.status = STATUS_CANCELLED if job.cancel_requested else STATUS_FAILED
            job.phase = PHASE_CANCELLED if job.cancel_requested else PHASE_FAILED
            if timed_out.is_set() and not job.error_text:
                job.error_text = f'Tool error: write job timed out after {CLARA_WRITE_JOB_TIMEOUT_SEC}s.'
            elif job.cancel_requested and not job.error_text:
                job.error_text = f'Tool error: write job `{job.job_id}` was cancelled.'
            _cleanup_temp(job)
            return
        if isinstance(text, str) and text.startswith('Tool error:'):
            job.status = STATUS_FAILED
            job.phase = PHASE_FAILED
            job.error_text = text
            _cleanup_temp(job)
            return
        job.result_text = text
        job.status = STATUS_DONE
        job.phase = PHASE_DONE

    worker = threading.Thread(
        target=body,
        name=f'clara-write-{job.job_id}',
        daemon=True,
    )
    worker.start()
    worker.join(timeout=float(CLARA_WRITE_JOB_TIMEOUT_SEC))
    if worker.is_alive():
        timed_out.set()
        with job.commit_lock:
            if job.committed:
                logger.warning(
                    'write job timed out after commit id=%s path=%s timeout=%ss',
                    job.job_id,
                    job.rel_display,
                    CLARA_WRITE_JOB_TIMEOUT_SEC,
                )
            elif job.status == STATUS_RUNNING:
                job.cancel_requested = True
                job.status = STATUS_FAILED
                job.phase = PHASE_FAILED
                job.error_text = f'Tool error: write job timed out after {CLARA_WRITE_JOB_TIMEOUT_SEC}s.'
                _cleanup_temp(job)
                logger.warning(
                    'write job timed out id=%s path=%s timeout=%ss',
                    job.job_id,
                    job.rel_display,
                    CLARA_WRITE_JOB_TIMEOUT_SEC,
                )
    _release_path_lock(job)
    job.done_thread.set()


def _register_write_job_locked(
    *,
    session_id: str,
    rel_display: str,
    tool_name: str,
    land_in_workspace: bool,
    runner: WriteJobRunner,
    payload: dict[str, Any] | None,
    extra_footer: str,
) -> WriteJob:
    job = WriteJob(
        job_id=uuid.uuid4().hex[:8],
        session_id=session_id,
        rel_display=rel_display.strip().replace('\\', '/'),
        tool_name=tool_name,
        land_in_workspace=land_in_workspace,
        started_at=time.monotonic(),
        runner=runner,
        payload=dict(payload or {}),
        extra_footer=extra_footer,
    )
    _JOBS[job.job_id] = job
    _PATH_RUNNING[_path_key(session_id, job.rel_display)] = job.job_id
    return job


def _spawn_write_watch(job: WriteJob) -> None:
    job.thread = threading.Thread(
        target=_run_job_thread,
        args=(job,),
        name=f'clara-write-watch-{job.job_id}',
        daemon=True,
    )
    job.thread.start()
    logger.info('write job started id=%s path=%s tool=%s', job.job_id, job.rel_display, job.tool_name)


def start_write_job(
    *,
    session_id: str,
    rel_display: str,
    tool_name: str,
    land_in_workspace: bool,
    runner: WriteJobRunner,
    payload: dict[str, Any] | None = None,
    extra_footer: str = '',
) -> WriteJob:
    """Register and start a write job. Caller must already hold the per-path lock check."""
    with _LOCK:
        job = _register_write_job_locked(
            session_id=session_id,
            rel_display=rel_display,
            tool_name=tool_name,
            land_in_workspace=land_in_workspace,
            runner=runner,
            payload=payload,
            extra_footer=extra_footer,
        )
    _spawn_write_watch(job)
    return job


def start_or_reuse_write_job(
    *,
    session_id: str,
    rel_display: str,
    tool_name: str,
    land_in_workspace: bool,
    runner: WriteJobRunner,
    payload: dict[str, Any] | None = None,
    extra_footer: str = '',
) -> tuple[WriteJob, bool]:
    """Return ``(job, reused)``. Reused jobs keep the in-flight write; ``land_in_workspace`` can latch true."""
    rel = rel_display.strip().replace('\\', '/')
    with _LOCK:
        existing_id = _PATH_RUNNING.get(_path_key(session_id, rel))
        existing = _JOBS.get(existing_id) if existing_id else None
        if existing is not None and existing.status == STATUS_RUNNING:
            if land_in_workspace:
                existing.land_in_workspace = True
            return existing, True
        job = _register_write_job_locked(
            session_id=session_id,
            rel_display=rel,
            tool_name=tool_name,
            land_in_workspace=land_in_workspace,
            runner=runner,
            payload=payload,
            extra_footer=extra_footer,
        )
    _spawn_write_watch(job)
    return job, False


def _apply_land(job: WriteJob, text: str) -> str:
    if not job.land_in_workspace or job.land_applied:
        return text
    session = get_session(job.session_id)
    from clara_coder_backend.tools import review_tools as _review_tools

    landed = _review_tools.run_staged_transfer_to_workspace(session, job.rel_display)
    job.land_applied = True
    return f'{text}\n\n---\n\n{landed}'


def _still_running_report(job: WriteJob, *, reused: bool, waited_sec: float) -> str:
    reused_bit = (
        f' A write is already running for `{job.rel_display}` — this call reused job `{job.job_id}` '
        'and did not start a second write.'
        if reused
        else ''
    )
    land_bit = (
        ' After this job reports staged, land will run on `wait_for_write` (or this call if it finishes first).'
        if job.land_in_workspace
        else ''
    )
    return (
        f'Write job still running.{reused_bit}\n'
        f'- Write id: `{job.job_id}`\n'
        f'- Path: `{job.rel_display}`\n'
        f'- Phase: {job.phase}\n'
        f'- Elapsed: {job.elapsed_sec()}s (waited {int(waited_sec)}s this call)\n'
        f'Next: `{WAIT_FOR_WRITE_NAME}` with write_id `{job.job_id}` to collect the result, '
        f'or `{CANCEL_WRITE_NAME}` to stop it. Do not start another write for this path.{land_bit}'
    )


def _finished_report(job: WriteJob) -> str:
    if job.status == STATUS_DONE:
        text = job.result_text
        if job.extra_footer:
            text = f'{text}{job.extra_footer}'
        return _apply_land(job, text)
    if job.error_text:
        return job.error_text
    if job.status == STATUS_CANCELLED:
        return f'Tool error: write job `{job.job_id}` was cancelled.'
    return f'Tool error: write job `{job.job_id}` failed.'


def format_write_job_report(job: WriteJob, *, reused: bool = False, waited_sec: float = 0.0) -> str:
    """Format the current job state; drop the job from the registry once terminal and reported."""
    if job.status == STATUS_RUNNING:
        return _still_running_report(job, reused=reused, waited_sec=waited_sec)
    report = _finished_report(job)
    _drop_job(job)
    return report


def wait_write_job_sync(job: WriteJob, wait_sec: float, *, reused: bool = False) -> str:
    """Block the current thread until the job finishes or ``wait_sec`` elapses."""
    started = time.monotonic()
    if wait_sec > 0 and not job.done_thread.is_set():
        job.done_thread.wait(timeout=wait_sec)
    return format_write_job_report(job, reused=reused, waited_sec=time.monotonic() - started)


async def wait_write_job(job: WriteJob, wait_sec: float, *, reused: bool = False) -> str:
    """Async wait used by ``wait_for_write`` (does not block the event loop)."""
    started = time.monotonic()
    if wait_sec > 0 and not job.done_thread.is_set():
        await asyncio.to_thread(job.done_thread.wait, wait_sec)
    return format_write_job_report(job, reused=reused, waited_sec=time.monotonic() - started)


def cancel_write_job(job: WriteJob) -> str:
    """Request cancel; do not commit if the runner has not finished. Prior drafts stay put."""
    with job.commit_lock:
        if job.committed:
            job.status = STATUS_DONE
            job.phase = PHASE_DONE
        elif job.status == STATUS_RUNNING:
            job.cancel_requested = True
            job.status = STATUS_CANCELLED
            job.phase = PHASE_CANCELLED
            job.error_text = f'Tool error: write job `{job.job_id}` was cancelled.'
            _cleanup_temp(job)
            _release_path_lock(job)
            job.done_thread.set()
    return format_write_job_report(job, waited_sec=0.0)


def _find_session_job(session_id: str, write_id: str) -> tuple[WriteJob | None, str | None]:
    cleaned = (write_id or '').strip()
    job = _JOBS.get(cleaned)
    if job is None or job.session_id != session_id:
        running = _running_session_jobs(session_id)
        hint = (
            f' Running writes: {", ".join(f"`{j.job_id}` (`{j.rel_display}`)" for j in running)}.'
            if running
            else ' No write jobs are running in this session.'
        )
        return None, f'Tool error: no write job with id `{cleaned or "(empty)"}`.{hint}'
    return job, None


async def cancel_session_write_jobs(session_id: str) -> None:
    """Cancel every write job for a session (used when the session is cleared)."""
    jobs = [job for job in list(_JOBS.values()) if job.session_id == session_id]
    for job in jobs:
        if job.status == STATUS_RUNNING:
            cancel_write_job(job)
        else:
            _drop_job(job)


@tool(WAIT_FOR_WRITE_NAME, description=describe(
    'Wait longer on a running staging write and collect its result (or land if that write asked to).',
    when=f'a `stage_*` tool reported a write as still running and you need the staged draft.',
    not_='starting a second write for the same path (reuse this id instead).',
    shape=(
        f'waits up to `wait_seconds` (default {CLARA_WRITE_JOB_DEFAULT_WAIT_SEC}s, 0 = status only, '
        f'max {CLARA_WRITE_JOB_MAX_WAIT_SEC}s). If `land_in_workspace` was set on the original stage call, '
        'land runs here when the job finishes.'
    ),
))
async def wait_for_write(
    write_id: Annotated[str, 'id returned by a still-running stage_* call'],
    wait_seconds: Annotated[float | None, 'extra seconds to wait; 0 = just report current status'] = None,
) -> str:
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    wait_sec, wait_err = _normalize_wait_seconds(wait_seconds, default=CLARA_WRITE_JOB_DEFAULT_WAIT_SEC)
    if wait_err:
        return wait_err
    assert wait_sec is not None
    job, find_err = _find_session_job(sid, write_id)
    if find_err:
        return find_err
    assert job is not None
    return await wait_write_job(job, wait_sec)


@tool(CANCEL_WRITE_NAME, description=describe(
    'Cancel a running staging write. The in-progress temp is dropped; any prior draft for that path is kept.',
    when='a write is stuck (formatter/LSP) or you no longer want that in-flight draft.',
    not_='discarding an already-committed staged draft (use `discard_staged_edits`).',
    shape=f'`write_id` from a still-running `stage_*` / `{WAIT_FOR_WRITE_NAME}` report.',
))
def cancel_write(
    write_id: Annotated[str, 'id returned by a still-running stage_* call'],
) -> str:
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    job, find_err = _find_session_job(sid, write_id)
    if find_err:
        return find_err
    assert job is not None
    return cancel_write_job(job)


@tool(LIST_WRITE_JOBS_NAME, description=describe(
    'List staging write jobs in this session (id, path, phase, elapsed).',
    when='recovering a lost write id or checking what is still running.',
    shape='read-only.',
))
def list_write_jobs() -> str:
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    jobs = [job for job in _JOBS.values() if job.session_id == sid]
    if not jobs:
        return 'No write jobs in this session.'
    lines = ['Write jobs:']
    for index, job in enumerate(sorted(jobs, key=lambda j: j.started_at), start=1):
        if job.status == STATUS_RUNNING:
            status = f'running ({job.phase}, {job.elapsed_sec()}s)'
        else:
            status = job.status
        lines.append(f'{index}. `{job.job_id}` — {status} — `{job.rel_display}`')
    return '\n'.join(lines) + '\n'


def write_job_tools() -> list[Any]:
    return [wait_for_write, cancel_write, list_write_jobs]


__all__ = [
    'CANCEL_WRITE_NAME',
    'LIST_WRITE_JOBS_NAME',
    'PHASE_CANCELLED',
    'PHASE_DONE',
    'PHASE_FAILED',
    'PHASE_FORMATTING',
    'PHASE_LSP',
    'PHASE_WRITING',
    'STATUS_CANCELLED',
    'STATUS_DONE',
    'STATUS_FAILED',
    'STATUS_RUNNING',
    'WAIT_FOR_WRITE_NAME',
    'WriteJob',
    'cancel_session_write_jobs',
    'cancel_write',
    'cancel_write_job',
    'format_write_job_report',
    'list_write_jobs',
    'publish_write_job_phase',
    'running_write_for_path',
    'start_or_reuse_write_job',
    'start_write_job',
    'wait_for_write',
    'wait_write_job',
    'wait_write_job_sync',
    'write_job_phase_detail',
    'write_job_tools',
    'write_jobs',
]
