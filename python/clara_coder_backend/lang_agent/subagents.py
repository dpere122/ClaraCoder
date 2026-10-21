"""Sub-agents: independent clones of the main agent that run one delegated task and report back.

The main agent's ``spawn_subagent`` tool (:mod:`clara_coder_backend.tools.spawn_subagent`) forks a child
session (:func:`fork_subagent_session`) and runs its single turn (:func:`run_subagent`) through the normal
:func:`~clara_coder_backend.composer.stream_agent_reply`. A child has the main agent's model, prompt and
tools except the sub-agent tools and ``propose_theme``; it shares the parent's workspace, LSP state and
edit journal, never has Admin, and cannot ask the user anything (its approval cards still work: Electron
shows them in the parent's dock and answers with the child's session id).

**Ownership.** A sub-agent belongs to the parent *conversation*, not to the turn that started it. It runs
until it reports, or until it is stopped: its card's Stop (``/chat/abort`` with the child id), the main
agent's ``stop_subagent``, ``/clear`` or ``/dispose`` of the parent, or app shutdown. Ending, interrupting
or failing the parent's turn does not stop it, and neither does ``/load``.

**Reports** reach the main agent exactly once each. A finished child's report is queued on the parent
(``subagent_pending_reports``) and taken by the first of: the spawn call that waits on it, a
``wait_for_subagents`` call, the next model call of a live parent turn
(:class:`~clara_coder_backend.middleware.subagent_results_middleware.SubagentResultsMiddleware`), the
next turn's input, or a turn Electron starts with ``continue_with_subagent_results`` after
``subagent_results_ready``.

**Events** go on the process-wide bus (:mod:`~clara_coder_backend.lang_agent.subagent_bus`, served by
``GET /subagents/events``), never on the parent's ``/chat/stream``:

- ``subagent_started`` ``{conversation_id, parent_conversation_id, parent_turn_id, name, task, status_id?,
  background}``: published by the parent stream's SSE mapper when it sees the spawn call's custom event
  (it knows the pill's status id), or by the child itself if that does not happen within a short wait.
  Always before any of the child's other events.
- ``subagent_event`` ``{conversation_id, payload}``: every child payload except ``[DONE]`` and
  ``subagent_*``, ``file_journal`` included (its ``userMessageId`` is the parent turn that spawned it).
- ``subagent_finished`` ``{conversation_id, outcome}``: exactly once, after the child's last event.
- ``subagent_results_ready`` ``{parent_conversation_id, names}``: reports are waiting and no parent turn
  is live to take them (see :func:`maybe_publish_results_ready`).

The child task starts in a blank :class:`contextvars.Context`. The spawn tool body runs with the parent's
LangChain callback config as its current context, and anything started inside it would inherit those
callbacks, so the parent's ``astream_events`` would capture the child's tokens and tool events as its own.
"""

from __future__ import annotations

import asyncio
import contextvars
import dataclasses
import json
import logging
import time
from collections import OrderedDict
from collections.abc import Iterable
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any

from clara_coder_backend.config import CLARA_SUBAGENT_MAX_CONCURRENCY
from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.lang_agent.subagent_bus import SUBAGENT_BUS
from clara_coder_backend.session import state
from clara_coder_backend.session.state import touch_session
from clara_coder_backend.tools.tool_conventions import tool_output_cap

logger = logging.getLogger('clara.agent.subagents')

#: Custom LangChain event the spawn tool dispatches; the SSE mapper turns it into ``subagent_started``.
SUBAGENT_STARTED_EVENT = 'clara_subagent_started'

#: How long a stopped sub-agent gets to wind down on its own before its task is cancelled.
SUBAGENT_STOP_GRACE_SEC = 3.0

#: Longest sub-agent label (``spawn_subagent`` ``name``), uniqueness suffix included.
SUBAGENT_NAME_MAX_CHARS = 40

#: How long a child waits for the parent stream to announce it (``subagent_started``) before streaming.
_ANNOUNCE_WAIT_SEC = 2.0

#: Cap on one report handed to the main agent (the full transcript stays in the child conversation).
_REPORT_MAX_CHARS = 12_000

#: Retired child ids remembered so routes reject them instead of recreating a session.
_RETIRED_MAX = 1024

#: Heads the reports delivered outside a spawn / wait call (injected message, continue turn).
REPORTS_ARRIVED_HEADER = (
    'Results from sub-agents you started arrived (the user has not seen these reports; '
    'pass on what matters in your reply):'
)

#: Closes the reports handed over when the turn would otherwise end (end-of-turn wait, continue turn).
CONTINUE_WITH_REPORTS_TEXT = 'Continue the task with these results.'

#: User content of a ``continue_with_subagent_results`` turn whose reports were already delivered.
NO_NEW_REPORTS_TEXT = 'No new sub-agent results; continue or wrap up.'

_runs: dict[str, SubagentRun] = {}
_retired: OrderedDict[str, None] = OrderedDict()
#: Fire-and-forget teardown / reaper tasks (strong references until they finish).
_background: set[asyncio.Task] = set()


@dataclass(eq=False)
class SubagentRun:
    """One spawned sub-agent: the sessions involved, how it was started, and how it ended."""

    parent_session_id: str
    parent: SessionState
    child_id: str
    child: SessionState
    name: str
    task_text: str
    #: Started with ``background=true`` (the spawn call returned at once).
    background: bool = False
    #: The parent turn (``current_user_message_id``) that spawned it; its edits are journaled under it.
    parent_turn_id: str = ''
    #: Editor mode of the spawning turn (a queued sub-agent may start after the parent's next turn began).
    apply_mode: bool = False
    started_at: float = field(default_factory=time.monotonic)
    outcome: LangGraphWorkerOutcome = field(default_factory=LangGraphWorkerOutcome)
    announced: asyncio.Event = field(default_factory=asyncio.Event)
    #: ``subagent_started`` went out on the bus.
    started_published: bool = False
    #: The child's turn started streaming (before that, a stop just cancels the task).
    streaming: bool = False
    #: Spawn / ``wait_for_subagents`` calls waiting on it right now.
    waiters: int = 0
    #: Who stopped it (``the user`` / ``the main agent``), empty when it was not stopped.
    stopped_by: str = ''
    #: Drop the report instead of queuing it (its conversation was cleared or deleted).
    discard_report: bool = False
    #: Background commands still running when the child ended (stopped then, listed in the report).
    stopped_commands: list[str] = field(default_factory=list)
    #: ``completed`` | ``aborted`` | ``error`` once the child ended.
    finish: str = ''
    task: asyncio.Task | None = None


@dataclass(frozen=True)
class SubagentReport:
    """A finished sub-agent's report, waiting on its parent until the main agent gets it."""

    child_id: str
    name: str
    text: str
    outcome: str


def _keep(task: asyncio.Task) -> asyncio.Task:
    _background.add(task)
    task.add_done_callback(_background.discard)
    return task


# ---------------------------------------------------------------------------
# Sessions, names and lookups
# ---------------------------------------------------------------------------


def subagent_session(session_id: str) -> SessionState | None:
    """The live sub-agent session for ``session_id`` (never creates one), else None."""
    sess = state.sessions.get((session_id or '').strip())
    if sess is not None and sess.subagent_parent_session_id:
        return sess
    return None


def is_subagent_session_id(session_id: str) -> bool:
    """True for a live or retired sub-agent id (routes must not treat it as a main conversation)."""
    sid = (session_id or '').strip()
    return bool(sid) and (sid in _retired or subagent_session(sid) is not None)


def _retire(child_id: str) -> None:
    _retired[child_id] = None
    _retired.move_to_end(child_id)
    while len(_retired) > _RETIRED_MAX:
        _retired.popitem(last=False)


def parent_subagent_semaphore(parent: SessionState) -> asyncio.Semaphore:
    """This parent's concurrency cap (``CLARA_SUBAGENT_MAX_CONCURRENCY``), created on first use."""
    if parent.subagent_semaphore is None:
        parent.subagent_semaphore = asyncio.Semaphore(CLARA_SUBAGENT_MAX_CONCURRENCY)
    return parent.subagent_semaphore


def fork_subagent_session(parent_sid: str, parent: SessionState, child_id: str, name: str) -> SessionState:
    """Create and register the child session for one sub-agent.

    The workspace attachment is copied (with its own semantic-index batch). LSP state and the edit
    journal are shared by identity: one language-server set and one journal "before" snapshot per path
    per user turn for the whole family. Auto Run follows the parent; Admin is always off.
    """
    child = SessionState(
        workspace=dataclasses.replace(parent.workspace, semantic_index_pending=[]),
        lsp=parent.lsp,
        edits=parent.edits,
    )
    child.subagent_parent_session_id = parent_sid
    child.subagent_name = name
    child.auto_apply_mode = parent.auto_apply_mode
    child.admin_elevation_granted = False
    child.current_user_message_id = parent.current_user_message_id
    # A fresh session has ``last_touched=0`` and would be the first idle eviction.
    touch_session(child)
    state.sessions[child_id] = child
    return child


def live_subagent_runs(parent: SessionState) -> list[SubagentRun]:
    """The parent's sub-agents that have not ended yet, oldest first."""
    return [run for run in _runs.values() if run.parent is parent and not run.finish]


def has_running_subagents(session: SessionState) -> bool:
    """True while ``session`` (a main session) has a sub-agent that has not ended."""
    return bool(session.subagent_children) or any(run.parent is session and not run.finish for run in _runs.values())


def unique_subagent_name(parent: SessionState, label: str) -> str:
    """``label``, or ``label-2``, ``label-3``… when a live sub-agent or waiting report already uses it."""
    taken = {run.name for run in live_subagent_runs(parent)}
    taken |= {report.name for report in parent.subagent_pending_reports.values()}
    if label not in taken:
        return label
    n = 2
    while True:
        suffix = f'-{n}'
        candidate = label[: SUBAGENT_NAME_MAX_CHARS - len(suffix)].rstrip() + suffix
        if candidate not in taken:
            return candidate
        n += 1


def find_subagent(parent: SessionState, key: str) -> SubagentRun | SubagentReport | None:
    """A live run or a waiting report of ``parent`` by child id or name (exact, then case-insensitive)."""
    wanted = (key or '').strip().strip('`').strip()
    if not wanted:
        return None
    runs = live_subagent_runs(parent)
    reports = list(parent.subagent_pending_reports.values())
    for item in [*runs, *reports]:
        if item.child_id == wanted or item.name == wanted:
            return item
    folded = wanted.casefold()
    for item in [*runs, *reports]:
        if item.name.casefold() == folded:
            return item
    return None


def register_subagent_run(run: SubagentRun) -> None:
    """Make ``run`` findable (announcement, names, stops) before its start event is dispatched."""
    _runs[run.child_id] = run


def forget_subagent_run(run: SubagentRun) -> None:
    """Undo :func:`register_subagent_run` for a run that never started, and release its session."""
    if _runs.get(run.child_id) is run:
        _runs.pop(run.child_id, None)
    if run.started_published and not run.finish:
        # Announced already (the parent stream was quick): close it for Electron.
        run.finish = 'aborted'
        _publish({'type': 'subagent_finished', 'conversation_id': run.child_id, 'outcome': 'aborted'})
    schedule_subagent_teardown(run.child_id)


def _elapsed(seconds: float) -> str:
    total = max(0, int(seconds))
    if total < 60:
        return f'{total}s'
    if total < 3600:
        return f'{total // 60}m {total % 60:02d}s'
    return f'{total // 3600}h {total % 3600 // 60:02d}m'


def running_subagents_line(session: SessionState) -> str:
    """One compact per-turn preamble line naming this main session's running sub-agents ('' if none)."""
    runs = live_subagent_runs(session)
    if not runs:
        return ''
    now = time.monotonic()
    parts = [
        f'`{run.name}` ({"waited on" if run.waiters else "background"}, {_elapsed(now - run.started_at)})'
        for run in runs
    ]
    return (
        '- Sub-agents still running (their reports reach you by themselves; wait_for_subagents / '
        'stop_subagent): ' + ', '.join(parts)
    )


# ---------------------------------------------------------------------------
# Bus events
# ---------------------------------------------------------------------------


def _publish(event: dict[str, Any]) -> None:
    try:
        SUBAGENT_BUS.publish(event)
    except Exception:
        logger.warning('Publishing a sub-agent event failed (%s)', event.get('type'), exc_info=True)


def _started_event(
    *,
    child_id: str,
    parent_sid: str,
    parent_turn_id: str,
    name: str,
    task: str,
    background: bool,
    status_id: str,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        'type': 'subagent_started',
        'conversation_id': child_id,
        'parent_conversation_id': parent_sid,
        'parent_turn_id': parent_turn_id,
        'name': name,
        'task': task,
    }
    if status_id:
        event['status_id'] = status_id
    event['background'] = bool(background)
    return event


def _publish_started(run: SubagentRun, status_id: str = '') -> None:
    """Publish ``subagent_started`` once (the first of the SSE mapper and the child's own fallback)."""
    if run.started_published:
        return
    run.started_published = True
    _publish(
        _started_event(
            child_id=run.child_id,
            parent_sid=run.parent_session_id,
            parent_turn_id=run.parent_turn_id,
            name=run.name,
            task=run.task_text,
            background=run.background,
            status_id=status_id,
        )
    )


def announce_subagent(data: dict[str, Any], status_id: str) -> None:
    """The parent stream saw the spawn call's start event: publish ``subagent_started`` with the pill id.

    Lets the child start streaming. A child that already announced itself (the parent stream was slow)
    or already ended is not announced twice.
    """
    child_id = str(data.get('conversation_id') or '').strip()
    if not child_id:
        return
    run = _runs.get(child_id)
    if run is not None:
        _publish_started(run, status_id)
        run.announced.set()
        return
    if child_id in _retired:
        return
    # No run registered (a direct call outside the spawn tool): announce from the event itself.
    _publish(
        _started_event(
            child_id=child_id,
            parent_sid=str(data.get('parent_conversation_id') or ''),
            parent_turn_id=str(data.get('parent_turn_id') or ''),
            name=str(data.get('name') or ''),
            task=str(data.get('task') or ''),
            background=bool(data.get('background')),
            status_id=status_id,
        )
    )


def _sse_payload(line: str) -> dict[str, Any] | None:
    """The JSON payload of one ``data: …`` SSE line; None for ``[DONE]`` and anything else."""
    text = line.strip()
    if not text.startswith('data:'):
        return None
    body = text[len('data:') :].strip()
    if not body or body == '[DONE]':
        return None
    try:
        payload = json.loads(body)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _forward_child_line(run: SubagentRun, line: str) -> None:
    payload = _sse_payload(line)
    if payload is None:
        return
    kind = payload.get('type')
    if isinstance(kind, str) and kind.startswith('subagent_'):
        return
    _publish({'type': 'subagent_event', 'conversation_id': run.child_id, 'payload': payload})


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


def _finish_label(outcome: LangGraphWorkerOutcome) -> str:
    if outcome.state == AgentLoopOutcome.COMPLETED:
        return 'completed'
    if outcome.state in (AgentLoopOutcome.FAILED_CONFIGURATION, AgentLoopOutcome.FAILED_RUNTIME):
        return 'error'
    return 'aborted'


def _report_footer(run: SubagentRun) -> list[str]:
    lines: list[str] = []
    touched = sorted(run.child.subagent_touched_paths)
    if touched:
        lines += ['', 'Files it changed (read them before relying on the changes): ' + ', '.join(f'`{p}`' for p in touched)]
    if run.stopped_commands:
        lines += ['', 'Background commands it left running were stopped: ' + ', '.join(run.stopped_commands)]
    return lines


def subagent_report(run: SubagentRun) -> str:
    """The report of a sub-agent that ended: status line, its final reply (capped), files, stopped commands."""
    outcome = run.outcome
    label = f'Sub-agent `{run.name}`'
    if run.finish == 'completed':
        head, body = f'{label} finished. Its report:', outcome.final_text
    elif run.finish == 'error':
        detail = (outcome.error_detail or 'unknown error').strip()
        head, body = f'{label} failed ({detail}). Output so far:', outcome.partial_text or outcome.final_text
    else:
        who = run.stopped_by or 'the user'
        head, body = f'{label} was stopped by {who} before it finished. Its partial output:', outcome.partial_text
    return tool_output_cap('\n'.join([head, '', body.strip() or '(no text)', *_report_footer(run)]), _REPORT_MAX_CHARS)


def detached_subagent_note(run: SubagentRun) -> str:
    """Result for a waiting spawn call whose turn ended first (the next turn's repair uses it)."""
    if run.finish or (run.task is not None and run.task.done()):
        return (
            f'Sub-agent `{run.name}` finished as this turn ended. Its report is delivered to you separately.'
        )
    return (
        f'Sub-agent `{run.name}` is still running independently (this turn ended before it reported). '
        'Its report will be delivered to you when it finishes; you can call wait_for_subagents or stop_subagent.'
    )


def _queue_report(run: SubagentRun) -> None:
    """Queue the ended child's report on its parent (unless the conversation went away) and maybe notify."""
    if run.discard_report:
        return
    parent = state.sessions.get(run.parent_session_id)
    if parent is not run.parent:
        # Cleared (new session object) or deleted while the child ran: nobody to report to.
        return
    parent.subagent_pending_reports[run.child_id] = SubagentReport(
        child_id=run.child_id,
        name=run.name,
        text=subagent_report(run),
        outcome=run.finish,
    )
    maybe_publish_results_ready(run.parent_session_id)


def claim_subagent_report(parent: SessionState, child_id: str) -> SubagentReport | None:
    """Take one waiting report (it counts as delivered)."""
    return parent.subagent_pending_reports.pop(child_id, None)


def drain_subagent_reports(parent: SessionState) -> list[SubagentReport]:
    """Take every waiting report, in finish order (they count as delivered)."""
    reports = list(parent.subagent_pending_reports.values())
    parent.subagent_pending_reports.clear()
    return reports


def requeue_subagent_reports(parent: SessionState, reports: Iterable[SubagentReport]) -> None:
    """Put reports a failed turn took back in front of any queued since (no notification)."""
    later = dict(parent.subagent_pending_reports)
    parent.subagent_pending_reports.clear()
    for report in reports:
        parent.subagent_pending_reports[report.child_id] = report
    for child_id, report in later.items():
        parent.subagent_pending_reports.setdefault(child_id, report)


def format_subagent_reports(reports: Iterable[SubagentReport], *, closing: str = '') -> str:
    """One message carrying several reports (injected before a model call or as a continue turn)."""
    blocks = [report.text.strip() for report in reports]
    text = '\n\n'.join([REPORTS_ARRIVED_HEADER, *blocks])
    return f'{text}\n\n{closing}' if closing else text


def maybe_publish_results_ready(parent_sid: str, *, ending_turn: bool = False) -> bool:
    """Publish ``subagent_results_ready`` when reports wait and no parent turn is live to take them.

    A live turn (or one waiting to run) gets them before its next model call. ``ending_turn``: the
    caller is that turn's own cleanup, so only *another* pending turn counts. Returns True if published.
    """
    from clara_coder_backend.session.turns import session_turn_pending

    parent = state.sessions.get(parent_sid)
    if parent is None or parent.subagent_parent_session_id or not parent.subagent_pending_reports:
        return False
    if parent.subagent_live_turns > 0 or session_turn_pending(parent_sid, exclude_current=ending_turn):
        return False
    _publish(
        {
            'type': 'subagent_results_ready',
            'parent_conversation_id': parent_sid,
            'names': [report.name for report in parent.subagent_pending_reports.values()],
        }
    )
    return True


# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------


async def run_subagent(run: SubagentRun) -> None:
    """The child's one turn: wait for its announcement and a slot, stream it onto the bus, then finish.

    Runs as its own task in a blank context (see module docstring). Always ends with exactly one
    ``subagent_finished`` (after the child's last event), queues the report, then schedules teardown.
    """
    # Lazy: the composer imports the graph, which imports the tool registry that binds the spawn tool.
    from clara_coder_backend.composer import stream_agent_reply

    parent = run.parent
    finish = 'error'
    try:
        try:
            await asyncio.wait_for(run.announced.wait(), timeout=_ANNOUNCE_WAIT_SEC)
        except asyncio.TimeoutError:
            logger.debug('sub-agent %s announces itself (no parent stream announcement)', run.child_id)
        _publish_started(run)
        async with parent_subagent_semaphore(parent):
            if run.child.subagent_cancel_requested:
                run.outcome.mark_aborted()
            else:
                run.streaming = True
                async with aclosing(
                    stream_agent_reply(
                        run.child_id,
                        f'Task from the main agent:\n{run.task_text}',
                        apply_mode=run.apply_mode,
                        auto_apply_mode=parent.auto_apply_mode,
                        user_message_id=run.parent_turn_id,
                        outcome_sink=run.outcome,
                    )
                ) as lines:
                    async for line in lines:
                        _forward_child_line(run, line)
        finish = _finish_label(run.outcome)
    except asyncio.CancelledError:
        finish = 'aborted'
        raise
    except Exception:
        logger.exception('sub-agent %s failed', run.child_id)
        finish = 'error'
    finally:
        _publish_started(run)
        try:
            from clara_coder_backend.tools.run_command import stop_running_session_commands

            run.stopped_commands = await stop_running_session_commands(run.child_id)
        except (Exception, asyncio.CancelledError):
            # Teardown kills whatever is left; the finish marker must still go out.
            logger.debug('stopping sub-agent background commands failed', exc_info=True)
        if finish == 'aborted' and run.outcome.state == AgentLoopOutcome.RUNNING:
            run.outcome.mark_aborted(partial_text=run.outcome.partial_text)
        run.finish = finish
        _publish({'type': 'subagent_finished', 'conversation_id': run.child_id, 'outcome': finish})
        if parent.subagent_children.get(run.child_id) is run.task:
            parent.subagent_children.pop(run.child_id, None)
        if _runs.get(run.child_id) is run:
            _runs.pop(run.child_id, None)
        _queue_report(run)
        schedule_subagent_teardown(run.child_id)


def start_subagent(run: SubagentRun) -> asyncio.Task:
    """Start :func:`run_subagent` in a blank context and register it on the parent."""
    register_subagent_run(run)
    loop = asyncio.get_running_loop()
    task = contextvars.Context().run(loop.create_task, run_subagent(run))
    run.task = task
    run.parent.subagent_children[run.child_id] = task
    return task


async def wait_for_runs(runs: Iterable[SubagentRun], timeout: float | None) -> None:
    """Wait (bounded) until the given sub-agents ended; counts as waiting on them meanwhile.

    Never cancels them: cancelling the waiter leaves them running.
    """
    targets = [run for run in runs if run.task is not None and not run.task.done()]
    if not targets:
        return
    for run in targets:
        run.waiters += 1
    try:
        await asyncio.wait({run.task for run in targets if run.task is not None}, timeout=timeout)
    finally:
        for run in targets:
            run.waiters = max(0, run.waiters - 1)


async def wait_until_subagents_end(parent: SessionState, abort_event: asyncio.Event) -> bool:
    """Wait until every running sub-agent of ``parent`` ended; False when ``abort_event`` fired first."""
    while True:
        tasks = {task for task in parent.subagent_children.values() if not task.done()}
        if not tasks:
            return True
        if abort_event.is_set():
            return False
        abort_wait = asyncio.ensure_future(abort_event.wait())
        try:
            await asyncio.wait({*tasks, abort_wait}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            if not abort_wait.done():
                abort_wait.cancel()
        if abort_event.is_set():
            return False


# ---------------------------------------------------------------------------
# Stopping
# ---------------------------------------------------------------------------


def request_subagent_stop(child: SessionState) -> None:
    """Synchronous part of stopping a child: flag it, abort its stream, release a waiting card."""
    child.subagent_cancel_requested = True
    child.abort_event.set()
    pause = child.agent_pause_event
    if pause is not None:
        pause.set()


def _reap_after_grace(run: SubagentRun) -> None:
    """Cancel the child's task if it has not ended within :data:`SUBAGENT_STOP_GRACE_SEC`."""
    task = run.task
    if task is None or task.done():
        return

    async def reap() -> None:
        _done, pending = await asyncio.wait({task}, timeout=SUBAGENT_STOP_GRACE_SEC)
        if pending:
            logger.warning('sub-agent %s did not stop within %.0fs; cancelling', run.child_id, SUBAGENT_STOP_GRACE_SEC)
            task.cancel()

    _keep(asyncio.get_running_loop().create_task(reap()))


async def abort_subagent(child_id: str, *, by: str = 'the user', discard_report: bool = False) -> None:
    """Stop one sub-agent (its card's Stop, ``stop_subagent``, a reset); a retired id is a no-op.

    Its partial report is queued for the main agent unless ``discard_report``.
    """
    from clara_coder_backend.llm.http_transport import abort_in_flight_llm_requests

    run = _runs.get(child_id)
    child = subagent_session(child_id) or (run.child if run is not None else None)
    if child is None:
        return
    if run is not None:
        run.stopped_by = run.stopped_by or by
        run.discard_report = run.discard_report or discard_report
    if child is not None:
        request_subagent_stop(child)
    if run is not None and run.task is not None and not run.task.done():
        if not run.streaming:
            # Still waiting for its announcement or a slot: nothing to wind down.
            run.task.cancel()
        else:
            _reap_after_grace(run)
    try:
        await abort_in_flight_llm_requests(child_id)
    except Exception:
        logger.debug('closing a stopped sub-agent generation failed', exc_info=True)


async def _wait_or_cancel(tasks: set[asyncio.Task], timeout: float) -> None:
    live = {task for task in tasks if not task.done()}
    if not live:
        return
    _done, still = await asyncio.wait(live, timeout=timeout)
    for task in still:
        task.cancel()
    if still:
        await asyncio.wait(still, timeout=1.0)


async def stop_subagent(
    child_id: str,
    *,
    by: str = 'the user',
    timeout: float = SUBAGENT_STOP_GRACE_SEC + 1.0,
) -> None:
    """Abort one sub-agent and wait (bounded) until its turn ended."""
    child = subagent_session(child_id)
    run = _runs.get(child_id)
    parent = state.sessions.get(child.subagent_parent_session_id) if child is not None else None
    task = run.task if run is not None else None
    if task is None and parent is not None:
        task = parent.subagent_children.get(child_id)
    await abort_subagent(child_id, by=by)
    if task is not None:
        await _wait_or_cancel({task}, timeout)


async def stop_subagents(
    parent: SessionState | None,
    *,
    discard_reports: bool = True,
    timeout: float = SUBAGENT_STOP_GRACE_SEC + 1.0,
) -> None:
    """Stop all of a parent's sub-agents and wait (bounded) until they ended (``/clear``, ``/dispose``).

    With ``discard_reports`` (the conversation is going away) no report is queued and the waiting
    ones are dropped.
    """
    if parent is None:
        return
    tasks = dict(parent.subagent_children)
    for run in live_subagent_runs(parent):
        if run.task is not None:
            tasks.setdefault(run.child_id, run.task)
    for child_id in tasks:
        await abort_subagent(child_id, by='the user', discard_report=discard_reports)
    await _wait_or_cancel(set(tasks.values()), timeout)
    if discard_reports:
        parent.subagent_pending_reports.clear()


async def stop_all_subagents(*, timeout: float = SUBAGENT_STOP_GRACE_SEC + 1.0) -> None:
    """App shutdown: stop every sub-agent (reports dropped)."""
    runs = [run for run in _runs.values() if not run.finish]
    for run in runs:
        await abort_subagent(run.child_id, discard_report=True)
    await _wait_or_cancel({run.task for run in runs if run.task is not None}, timeout)


async def teardown_subagent(child_id: str) -> None:
    """Release a finished child: commands, checkpoint threads, Admin helper, and its session entry."""
    from clara_coder_backend.session.lifecycle import teardown_session

    _retire(child_id)
    try:
        await teardown_session(child_id)
    except Exception:
        logger.debug('sub-agent teardown failed sid=%s', child_id, exc_info=True)
    finally:
        state.sessions.pop(child_id, None)


def schedule_subagent_teardown(child_id: str) -> None:
    """Fire-and-forget :func:`teardown_subagent` (the id is retired right away)."""
    _retire(child_id)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        state.sessions.pop(child_id, None)
        return
    _keep(loop.create_task(teardown_subagent(child_id)))


def reset_subagents_for_tests() -> None:
    """Forget runs, retired ids, background task references and the bus."""
    _runs.clear()
    _retired.clear()
    _background.clear()
    SUBAGENT_BUS.reset()


__all__ = [
    'CONTINUE_WITH_REPORTS_TEXT',
    'NO_NEW_REPORTS_TEXT',
    'REPORTS_ARRIVED_HEADER',
    'SUBAGENT_NAME_MAX_CHARS',
    'SUBAGENT_STARTED_EVENT',
    'SUBAGENT_STOP_GRACE_SEC',
    'SubagentReport',
    'SubagentRun',
    'abort_subagent',
    'announce_subagent',
    'claim_subagent_report',
    'detached_subagent_note',
    'drain_subagent_reports',
    'find_subagent',
    'fork_subagent_session',
    'forget_subagent_run',
    'format_subagent_reports',
    'has_running_subagents',
    'is_subagent_session_id',
    'live_subagent_runs',
    'maybe_publish_results_ready',
    'parent_subagent_semaphore',
    'register_subagent_run',
    'request_subagent_stop',
    'requeue_subagent_reports',
    'reset_subagents_for_tests',
    'run_subagent',
    'running_subagents_line',
    'schedule_subagent_teardown',
    'start_subagent',
    'stop_all_subagents',
    'stop_subagent',
    'stop_subagents',
    'subagent_report',
    'subagent_session',
    'teardown_subagent',
    'unique_subagent_name',
    'wait_for_runs',
    'wait_until_subagents_end',
]
