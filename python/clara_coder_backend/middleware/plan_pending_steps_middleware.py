"""Plan execution: when the executor answers while plan steps are still unchecked, send it back once."""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.agents.middleware.types import ContextT
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime
from typing_extensions import override

from clara_coder_backend.lang_agent.subagents import has_running_subagents
from clara_coder_backend.middleware.empty_response_middleware import emit_agent_nudge_event
from clara_coder_backend.plan.build_plan_store import parse_action_steps, read_build_plan_text
from clara_coder_backend.session import state as session_state
from clara_coder_backend.session.state import current_session_id
from clara_coder_backend.workspace.paths import truncate_text

logger = logging.getLogger('clara.agent.plan_pending_steps')

_STEP_TEXT_MAX_CHARS = 160
_MAX_LISTED_STEPS = 12


def pending_steps_message(pending: list[dict[str, Any]]) -> str:
    # Imported here: the build-plan tools import ``plan_execute``, which builds its graph with this module.
    from clara_coder_backend.plan.build_plan_tools import MARK_BUILD_PLAN_STEPS_COMPLETE_NAME

    lines = ['Automatic check (from the app, not from the user): the build plan still has unchecked steps.']
    for step in pending[:_MAX_LISTED_STEPS]:
        text = truncate_text(' '.join(str(step.get('text') or '').split()), _STEP_TEXT_MAX_CHARS)
        lines.append(f"- {step.get('id')}: {text}")
    if len(pending) > _MAX_LISTED_STEPS:
        lines.append(f'... and {len(pending) - _MAX_LISTED_STEPS} more.')
    lines.append(
        f'Finish them now. If a step is already done, mark it with `{MARK_BUILD_PLAN_STEPS_COMPLETE_NAME}`; '
        'if a step cannot or should not be done, leave it unchecked and say why in your reply.'
    )
    return '\n'.join(lines)


class PlanPendingStepsMiddleware(AgentMiddleware):
    """Once per plan, hand the unchecked steps back to an executor that tries to finish.

    A forgotten mark and a skipped step look the same from outside, so the model sorts them out
    itself; its second answer stands.
    """

    @hook_config(can_jump_to=['model'])
    @override
    async def aafter_model(self, state: Any, runtime: Runtime[ContextT]) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        msgs = state.get('messages') or []
        last = msgs[-1] if msgs else None
        if not isinstance(last, AIMessage) or last.tool_calls or (getattr(last, 'invalid_tool_calls', None) or ()):
            return None
        sid = (current_session_id.get() or '').strip()
        session = session_state.sessions.get(sid) if sid else None
        if session is None or session.subagent_parent_session_id or session.abort_event.is_set():
            return None
        if session.harness_final_text or has_running_subagents(session) or session.subagent_pending_reports:
            return None
        plan_id = (session.active_build_plan_id or '').strip()
        if not plan_id or session.pending_steps_nudged_plan_id == plan_id:
            return None
        try:
            steps = parse_action_steps(read_build_plan_text(session))
        except (FileNotFoundError, OSError):
            return None
        pending = [step for step in steps if not step.get('complete')]
        if not pending:
            return None
        session.pending_steps_nudged_plan_id = plan_id
        logger.info('Plan executor finished with %d unchecked step(s); handing them back once', len(pending))
        await emit_agent_nudge_event(reason='plan_steps')
        return {'messages': [HumanMessage(content=pending_steps_message(pending))], 'jump_to': 'model'}


__all__ = ['PlanPendingStepsMiddleware', 'pending_steps_message']
