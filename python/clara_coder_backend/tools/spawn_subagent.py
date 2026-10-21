"""``spawn_subagent``: hand a self-contained task to an independent clone of the main agent.

By default the call waits for the sub-agent's report and returns it. With ``background=true`` it returns
at once; the report reaches the main agent later by itself (before a later model call, from
``wait_for_subagents``, or by continuing the turn when it would otherwise end). Calls in one model
response run in parallel, up to ``CLARA_SUBAGENT_MAX_CONCURRENCY`` per session (the rest wait for a
slot). There are no follow-ups: a sub-agent ends after its report.

A sub-agent belongs to the conversation, not to this call: when the turn ends while the call waits
(interrupt, Stop), the sub-agent keeps running and its report is delivered when it finishes. Bound for
main agent-mode sessions only (never for sub-agents, never in plan mode); see
:mod:`clara_coder_backend.lang_agent.subagents` for the session fork, ownership and event contract.

The result's artifact (``{'subagent': {conversation_id, name}}``) links the spawn pill to the child
conversation; it stays in the checkpoint and the model never sees it.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Annotated, Any

from langchain_core.callbacks import Callbacks, adispatch_custom_event
from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import patch_config
from langchain_core.tools import InjectedToolCallId, tool

from clara_coder_backend.lang_agent.subagents import (
    SUBAGENT_NAME_MAX_CHARS,
    SUBAGENT_STARTED_EVENT,
    SubagentRun,
    claim_subagent_report,
    detached_subagent_note,
    fork_subagent_session,
    forget_subagent_run,
    register_subagent_run,
    start_subagent,
    subagent_report,
    unique_subagent_name,
    wait_for_runs,
)
from clara_coder_backend.session import state
from clara_coder_backend.session.state import current_session_id
from clara_coder_backend.tools.tool_conventions import describe

logger = logging.getLogger('clara.tools.spawn_subagent')

SPAWN_SUBAGENT_NAME = 'spawn_subagent'

_DEFAULT_NAME = 'sub-agent'


def _clean_name(name: str) -> str:
    label = ' '.join((name or '').split())
    if len(label) > SUBAGENT_NAME_MAX_CHARS:
        label = label[: SUBAGENT_NAME_MAX_CHARS - 1].rstrip() + '…'
    return label or _DEFAULT_NAME


def _background_started_text(run: SubagentRun) -> str:
    return (
        f'Started sub-agent `{run.name}` in the background (id {run.child_id}). Keep working: its report is '
        'delivered to you by itself before a later step (or call wait_for_subagents); if you finish first, '
        'the turn waits for it.'
    )


@tool(
    SPAWN_SUBAGENT_NAME,
    description=describe(
        'Hand a task to a sub-agent (an independent copy of you with your tools) and get its report',
        when='work splits into independent parts (separate areas to investigate or edit); '
        'several calls in one response run in parallel. `background=true` if you have other work meanwhile',
        not_='small steps you can do yourself, follow-ups to an earlier sub-agent (it ends after reporting), '
        'or anything that needs the user (sub-agents cannot ask)',
        shape='`task` must stand alone: the sub-agent sees none of this chat. Give each sub-agent disjoint files',
        verify='read the files a report says changed before relying on them',
    ),
    response_format='content_and_artifact',
)
async def spawn_subagent_tool(
    task: Annotated[str, 'complete instructions: goal, relevant paths, constraints, what to report back'],
    name: Annotated[str, 'short unique label shown to the user, e.g. "api-tests"'],
    tool_call_id: Annotated[str, InjectedToolCallId],
    config: RunnableConfig,
    background: Annotated[
        bool,
        'return at once; the report reaches you by itself before a later step (or via wait_for_subagents), '
        'and if you finish first the turn waits for it',
    ] = False,
    callbacks: Callbacks = None,
) -> tuple[str, dict[str, Any]]:
    sid = (current_session_id.get() or '').strip()
    parent = state.sessions.get(sid) if sid else None
    if parent is None:
        return 'Tool error: no active session.', {}
    if parent.subagent_parent_session_id:
        return 'Tool error: sub-agents cannot start sub-agents; do the work yourself.', {}
    task_text = (task or '').strip()
    if not task_text:
        return 'Tool error: `task` is empty; describe the whole job the sub-agent should do.', {}
    label = unique_subagent_name(parent, _clean_name(name))

    child_id = uuid.uuid4().hex
    child = fork_subagent_session(sid, parent, child_id, label)
    run = SubagentRun(
        parent_session_id=sid,
        parent=parent,
        child_id=child_id,
        child=child,
        name=label,
        task_text=task_text,
        background=bool(background),
        parent_turn_id=parent.current_user_message_id,
        apply_mode=bool(parent.last_stream_apply_mode),
    )
    artifact = {'subagent': {'conversation_id': child_id, 'name': label}}
    # Findable before the start event is dispatched: the parent stream may map it right away.
    register_subagent_run(run)
    try:
        # ``callbacks`` is this tool run's child manager: the event's run id is the call's own (the
        # injected ``config`` alone would attribute it to the tools node), so the stream mapper finds
        # the pill. The explicit config also works where asyncio cannot carry it (3.10).
        await adispatch_custom_event(
            SUBAGENT_STARTED_EVENT,
            {
                'conversation_id': child_id,
                'parent_conversation_id': sid,
                'parent_turn_id': run.parent_turn_id,
                'name': label,
                'task': task_text,
                'background': run.background,
            },
            config=patch_config(config, callbacks=callbacks),
        )
    except asyncio.CancelledError:
        forget_subagent_run(run)
        raise
    except Exception:
        # No parent run to announce on (e.g. a direct call); the child announces itself after a short wait.
        logger.debug('sub-agent start event not dispatched', exc_info=True)
    child_task = start_subagent(run)
    if run.background:
        return _background_started_text(run), artifact

    try:
        # ``wait``, not ``await child_task``: cancelling this call must not cancel the child.
        await wait_for_runs([run], timeout=None)
    except asyncio.CancelledError:
        # The turn ended first: the sub-agent keeps running and reports when it finishes.
        parent.subagent_interrupted_reports[tool_call_id] = detached_subagent_note(run)
        raise
    if not child_task.done():  # pragma: no cover - ``wait`` without timeout returns only when done
        return detached_subagent_note(run), artifact
    report = claim_subagent_report(parent, child_id)
    return (report.text if report is not None else subagent_report(run)), artifact


__all__ = [
    'SPAWN_SUBAGENT_NAME',
    'spawn_subagent_tool',
]
