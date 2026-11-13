"""Verify an editing turn before it ends, and hand failures back to the model.

When the model answers without tool calls, the harness itself looks at what the turn left behind:
language-server errors on the files it touched (minus the ones those files already had) and the
workspace's check commands from ``.clara/checks.json`` (see :mod:`clara_coder_backend.verify`). A
failure goes back to the model as a message, at most ``verify_max_fix_rounds`` times per turn; after
that the turn ends and the failed result stays visible in the transcript.
"""

from __future__ import annotations

import itertools
import logging
import time
from pathlib import Path
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.agents.middleware.types import ContextT
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime
from typing_extensions import override

from clara_coder_backend.domain import SessionState, TurnVerifyState
from clara_coder_backend.lang_agent.streaming import status_event
from clara_coder_backend.lang_agent.subagents import has_running_subagents
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.lsp.file_policy import lsp_server_for_path
from clara_coder_backend.middleware.agent_nudge_event import emit_agent_nudge_event
from clara_coder_backend.session import state as session_state
from clara_coder_backend.session.file_journal import turn_touched_paths, turn_verify_state
from clara_coder_backend.session.state import current_session_id, verify_after_edits_enabled, verify_max_fix_rounds
from clara_coder_backend.verify.checks_config import check_applies, load_workspace_checks
from clara_coder_backend.verify.evidence import FEEDBACK_HEADER, VerificationResult, format_feedback, gather_evidence

logger = logging.getLogger('clara.agent.turn_verification')

#: Label of the verification pill (a normal tool status on the turn's stream).
VERIFY_PILL_LABEL = 'verify_turn'

_pill_ids = itertools.count(1)


def _main_session() -> SessionState | None:
    sid = (current_session_id.get() or '').strip()
    sess = session_state.sessions.get(sid) if sid else None
    if sess is None or sess.subagent_parent_session_id:
        return None
    return sess


def _emit_pill(
    session: SessionState, status_id: str, detail: str, pill_state: str, *, duration_ms: int | None = None
) -> None:
    """Queue the pill's status on the turn's stream (relayed by the nested-queue passthrough)."""
    queue = session.planning_nested_events_q
    if queue is None:
        return
    payload = status_event(
        status_id, VERIFY_PILL_LABEL, detail=detail, state=pill_state, source='tool', duration_ms=duration_ms
    )
    try:
        queue.put_nowait((f'verify-turn:{status_id}', {'event': 'subagent_sse', 'data': payload}))
    except Exception:
        logger.debug('verification pill not queued', exc_info=True)


def _declined_to_fix(messages: list[Any]) -> bool:
    """True when the model answered the last verification feedback without calling a single tool.

    It then explained instead of fixing (a failure it did not cause, say). Running the same checks
    again would only repeat the result, so its answer stands.
    """
    for message in reversed(messages):
        if isinstance(message, ToolMessage):
            return False
        if isinstance(message, HumanMessage):
            return stringify_content(message.content).startswith(FEEDBACK_HEADER)
    return False


class TurnVerificationMiddleware(AgentMiddleware):
    """Gate the end of an editing turn on LSP errors and the workspace's check commands.

    The last of the finish gates (:class:`FinishGatesMiddleware`): it runs after tool-call promotion,
    and after :class:`SubagentResultsMiddleware` waited for sub-agents that may still edit (a gate that
    sends the turn back to the model skips the gates after it).
    """

    @hook_config(can_jump_to=['model'])
    @override
    async def aafter_model(self, state: Any, runtime: Runtime[ContextT]) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        msgs = state.get('messages') or []
        last = msgs[-1] if msgs else None
        if not isinstance(last, AIMessage) or last.tool_calls or (getattr(last, 'invalid_tool_calls', None) or ()):
            return None
        session = _main_session()
        if session is None or session.abort_event.is_set() or not verify_after_edits_enabled():
            return None
        if session.harness_final_text or has_running_subagents(session) or session.subagent_pending_reports:
            return None
        turn_id = (session.current_user_message_id or '').strip()
        workspace = (session.workspace_path or '').strip()
        if not turn_id or not workspace:
            return None
        verify = turn_verify_state(session.edits, turn_id)
        mutations = verify.mutations
        if mutations == 0:
            return None
        if mutations == verify.verified_mutations and (not verify.last_failed or _declined_to_fix(msgs)):
            return None
        max_rounds = verify_max_fix_rounds()
        if verify.last_failed and mutations == verify.verified_mutations and verify.fix_rounds >= max_rounds:
            return None

        root = Path(workspace).resolve()
        touched = turn_touched_paths(session)
        checks = load_workspace_checks(root)
        applicable = [check for check in checks.enabled if check_applies(check, touched)]
        if not applicable and not checks.problems and not any(lsp_server_for_path(rel) for rel in touched):
            verify.verified_mutations = mutations
            verify.last_failed = False
            return None

        result = await self._gather(session, root, touched, verify, checks, max_rounds)
        if result is None or result.stopped or session.abort_event.is_set():
            return None
        verify.verified_mutations = mutations
        verify.last_failed = result.failed
        if not result.failed or verify.fix_rounds >= max_rounds:
            return None
        verify.fix_rounds += 1
        logger.info('Turn verification failed; fix round %d of %d', verify.fix_rounds, max_rounds)
        await emit_agent_nudge_event(reason='verify')
        feedback = format_feedback(result, fix_round=verify.fix_rounds, max_rounds=max_rounds)
        return {'messages': [HumanMessage(content=feedback)], 'jump_to': 'model'}

    async def _gather(
        self,
        session: SessionState,
        root: Path,
        touched: list[str],
        verify: TurnVerifyState,
        checks: Any,
        max_rounds: int,
    ) -> VerificationResult | None:
        """Gather the evidence behind a pill; None when it could not be gathered."""
        fix_rounds = verify.fix_rounds
        sid = (current_session_id.get() or '').strip()
        status_id = f'verify-turn-{next(_pill_ids)}'
        noun = 'file' if len(touched) == 1 else 'files'
        scope = f'{len(touched)} {noun}'
        _emit_pill(session, status_id, scope, 'running')
        started = time.monotonic()
        detail, pill_state = scope, 'complete'
        session.verify_running = True
        try:
            result = await gather_evidence(
                sid,
                root,
                touched_paths=touched,
                baseline_errors=verify.baseline_errors,
                checks=checks,
                stop_event=session.abort_event,
                baseline_texts=verify.baseline_texts,
            )
            if result.stopped:
                detail = 'stopped'
            else:
                detail = result.summary() or scope
                if result.failed:
                    pill_state = 'error'
                    if fix_rounds >= max_rounds > 0:
                        detail += f' · not fixed after {fix_rounds} fix round(s)'
            return result
        except Exception:
            # Verification is a safety net: when it breaks, the turn ends as it would have without it.
            logger.exception('Turn verification could not run')
            detail = 'could not run'
            return None
        finally:
            # Also when the turn is stopped (cancelled) mid-check: the pill must not spin forever.
            session.verify_running = False
            _emit_pill(
                session, status_id, detail, pill_state, duration_ms=int((time.monotonic() - started) * 1000)
            )


__all__ = ['TurnVerificationMiddleware', 'VERIFY_PILL_LABEL']
