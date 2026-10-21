"""Deliver sub-agent reports to a live main-agent turn, and keep the turn going until they arrive.

Bound on the chat turns of main sessions (with the sub-agent tools; see
:func:`~clara_coder_backend.lang_agent.graph.build_clara_single_outer_graph`). Reports waiting on the
session (:mod:`~clara_coder_backend.lang_agent.subagents`) reach the model two ways:

- **Before each model call** they are added to the conversation as one HumanMessage. Unlike the
  per-call user event notes, this is a state update: the message stays in the checkpoint, so later
  steps (and later turns) still see it.
- **When the model is done** (an answer with no tool calls) while sub-agents are still running or
  reports wait, the turn does not end: a ``wait_for_subagents`` pill shows on the parent stream, the hook
  waits until every running sub-agent ended, then adds their reports and jumps back to the model.
  Stopping the turn during the wait ends it normally; the sub-agents keep running and their reports
  are delivered later (``subagent_results_ready`` once no turn is live).
"""

from __future__ import annotations

import itertools
import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT
from typing_extensions import override

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent.streaming import status_event
from clara_coder_backend.lang_agent.subagents import (
    CONTINUE_WITH_REPORTS_TEXT,
    drain_subagent_reports,
    format_subagent_reports,
    live_subagent_runs,
    wait_until_subagents_end,
)
from clara_coder_backend.session import state as session_state
from clara_coder_backend.session.state import current_session_id

logger = logging.getLogger('clara.agent.subagent_results')

#: Label of the end-of-turn waiting pill (a normal tool status on the parent stream).
WAIT_PILL_LABEL = 'wait_for_subagents'

_wait_ids = itertools.count(1)


def _main_session() -> SessionState | None:
    sid = (current_session_id.get() or '').strip()
    sess = session_state.sessions.get(sid) if sid else None
    if sess is None or sess.subagent_parent_session_id:
        return None
    return sess


def _emit_pill(session: SessionState, status_id: str, detail: str, pill_state: str) -> None:
    """Queue the waiting pill's status on the parent stream (relayed by the nested-queue passthrough)."""
    queue = session.planning_nested_events_q
    if queue is None:
        return
    payload = status_event(status_id, WAIT_PILL_LABEL, detail=detail, state=pill_state, source='tool')
    try:
        queue.put_nowait((f'subagent-wait:{status_id}', {'event': 'subagent_sse', 'data': payload}))
    except Exception:
        logger.debug('sub-agent wait pill not queued', exc_info=True)


def _reports_message(session: SessionState, *, closing: str = '') -> HumanMessage | None:
    reports = drain_subagent_reports(session)
    if not reports:
        return None
    logger.info('Delivering %d sub-agent report(s) to the main agent', len(reports))
    return HumanMessage(content=format_subagent_reports(reports, closing=closing))


class SubagentResultsMiddleware(AgentMiddleware):
    """Inject waiting sub-agent reports before model calls; wait for running ones before the turn ends.

    Listed first among the agent's middleware so its ``after_model`` runs last, after tool-call
    promotion (Gemma / pseudo-XML) has settled whether the answer really has no tool calls.
    """

    @override
    async def abefore_model(self, state: Any, runtime: Runtime[ContextT]) -> dict[str, Any] | None:
        del state, runtime  # API contract; unused
        session = _main_session()
        if session is None:
            return None
        message = _reports_message(session)
        return {'messages': [message]} if message is not None else None

    @hook_config(can_jump_to=['model'])
    @override
    async def aafter_model(self, state: Any, runtime: Runtime[ContextT]) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        msgs = state.get('messages') or []
        last = msgs[-1] if msgs else None
        if not isinstance(last, AIMessage) or last.tool_calls or (getattr(last, 'invalid_tool_calls', None) or ()):
            return None
        session = _main_session()
        if session is None or session.abort_event.is_set():
            return None
        running = live_subagent_runs(session)
        if not running and not session.subagent_pending_reports:
            return None
        if running:
            status_id = f'subagent-wait-{next(_wait_ids)}'
            noun = 'sub-agent' if len(running) == 1 else 'sub-agents'
            detail = f'{len(running)} {noun}: ' + ', '.join(run.name for run in running)
            _emit_pill(session, status_id, detail, 'running')
            try:
                finished = await wait_until_subagents_end(session, session.abort_event)
            finally:
                # Also when the turn is stopped (cancelled) mid-wait: the pill must not spin forever.
                _emit_pill(session, status_id, detail, 'complete')
            if not finished:
                logger.info('Turn stopped while waiting for sub-agents; they keep running')
                return None
        message = _reports_message(session, closing=CONTINUE_WITH_REPORTS_TEXT)
        if message is None:
            return None
        return {'messages': [message], 'jump_to': 'model'}


__all__ = ['SubagentResultsMiddleware', 'WAIT_PILL_LABEL']
