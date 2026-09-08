"""End-of-turn LangGraph node that returns leftover staged drafts to the model.

``create_agent`` compiles :meth:`FlushUntransferredStagingMiddleware.aafter_agent` as
``FlushUntransferredStagingMiddleware.after_agent``. The agent loop reaches that node
only after the model would otherwise END.

When untransferred staged drafts remain in Editor mode, this node jumps back to the model
with review/resolve instructions. HITL / auto-apply happen only when the model itself
calls ``transfer_staged_file_to_workspace`` (or abort / Editor-off ends the turn and
turn-end cleanup drops leftover staging).

The after-model staging-continuation nudge in ``empty_response_middleware`` is legacy (off).
The Qwen optimization preset skips this leftover-draft re-prompt so the turn ends on the
base model→tools path; turn-end cleanup still restores leftover journals.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.agents.middleware.types import AgentState, PrivateStateAttr, ResponseT
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT
from typing_extensions import NotRequired, override

from clara_coder_backend.config import MAX_UNTRANSFERRED_DRAFT_REVIEW_NUDGES
from clara_coder_backend.middleware.empty_response_middleware import emit_agent_nudge_event
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.tools.review_tools import pending_untransferred_staging_paths

logger = logging.getLogger('clara.agent.langgraph')


def leftover_draft_review_enabled() -> bool:
    """False when the Qwen optimization preset is active (no after-agent re-prompt)."""
    try:
        from clara_coder_backend.llm.model_tuning import qwen_optimize_profile_active
        from clara_coder_backend.session.state import get_active_connection

        return not qwen_optimize_profile_active(get_active_connection())
    except Exception:
        return True


def untransferred_draft_review_nudge_text(paths: list[str], *, auto_apply: bool) -> str:
    """Human message that sends leftover drafts back to the model for review and resolve."""
    quoted = ', '.join(f'`{p}`' for p in paths)
    hitl = (
        ' Auto-apply is off—the keep-vs-restore diff card appears only after `transfer_staged_file_to_workspace` runs.'
        if not auto_apply
        else ''
    )
    return (
        f'You ended this turn with untransferred staged draft(s): {quoted}. '
        'Those files are already on disk. Do not stop. Review each leftover draft (inspect with '
        '`diff_staged_edit_against_baseline` or `read_staged_edit` if you need to check the work), then resolve '
        'every path before finishing: call `transfer_staged_file_to_workspace` with `relative_paths` listing every '
        f'path you intend to keep, or `discard_staged_edits` for any path you want restored to the journal.{hitl}'
    )


class _FlushUntransferredState(AgentState[ResponseT]):
    """Tracks after_agent leftover-draft review jumps (not exposed in I/O schema)."""

    untransferred_draft_review_streak: NotRequired[Annotated[int, PrivateStateAttr]]


class FlushUntransferredStagingMiddleware(AgentMiddleware):
    """``after_agent`` node: return leftover staged drafts to the model until they are resolved."""

    state_schema = _FlushUntransferredState  # type: ignore[assignment]

    @hook_config(can_jump_to=['model'])
    @override
    async def aafter_agent(
        self,
        state: _FlushUntransferredState,
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        if not leftover_draft_review_enabled():
            return None
        sid = (current_session_id.get() or '').strip()
        if not sid:
            return None
        session = get_session(sid)
        if session.abort_event.is_set():
            return None
        if not session.worker_apply_mode:
            return None
        if session.pending_staged_transfer_hitl is not None:
            return None
        paths = pending_untransferred_staging_paths(session)
        if not paths:
            return None

        streak = int(state.get('untransferred_draft_review_streak') or 0)
        if MAX_UNTRANSFERRED_DRAFT_REVIEW_NUDGES > 0 and streak >= MAX_UNTRANSFERRED_DRAFT_REVIEW_NUDGES:
            logger.warning(
                'Stopping leftover-draft review after %s jump(s); turn-end cleanup will restore journals: %s',
                streak,
                paths,
            )
            return None
        logger.info(
            'Returning untransferred staged draft(s) to the model (nudge %s): %s',
            streak + 1,
            paths,
        )
        await emit_agent_nudge_event(reason='staging')
        return {
            'messages': [
                HumanMessage(
                    content=untransferred_draft_review_nudge_text(
                        paths,
                        auto_apply=bool(session.auto_apply_mode),
                    )
                )
            ],
            'jump_to': 'model',
            'untransferred_draft_review_streak': streak + 1,
        }
