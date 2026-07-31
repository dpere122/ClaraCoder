"""LangChain tools for reading and updating the active build plan Markdown file."""

from __future__ import annotations

from typing import Annotated

from langchain_core.tools import tool

from clara_coder_backend.plan.build_plan_store import get_active_plan, mark_steps_complete, read_build_plan_text
from clara_coder_backend.plan.plan_execute import emit_planner_progress_from_md
from clara_coder_backend.session.state import current_session_id, get_session

READ_BUILD_PLAN_NAME = 'read_build_plan'
MARK_BUILD_PLAN_STEPS_COMPLETE_NAME = 'mark_build_plan_steps_complete'


def _resolve_tool_session():
    session_id = (current_session_id.get() or '').strip()
    if not session_id:
        return None, 'No active chat session.'
    return get_session(session_id), ''


@tool(READ_BUILD_PLAN_NAME)
def read_build_plan() -> str:
    """Read the full active build plan Markdown for this plan-mode session."""
    session, err = _resolve_tool_session()
    if session is None:
        return err
    try:
        return read_build_plan_text(session, chat_session_id=current_session_id.get() or None)
    except FileNotFoundError:
        return 'No active build plan for this session.'


@tool(MARK_BUILD_PLAN_STEPS_COMPLETE_NAME)
def mark_build_plan_steps_complete(
    step_ids: Annotated[list[str], 'Step ids to mark complete, e.g. ["step-1", "step-3"]'],
) -> str:
    """Mark one or more build plan action-step milestones complete (updates the MD checkboxes)."""
    session, err = _resolve_tool_session()
    if session is None:
        return err
    chat_session_id = current_session_id.get() or None
    record = get_active_plan(session, chat_session_id=chat_session_id)
    if not record:
        return 'No active build plan for this session.'
    root = (session.workspace_path or '').strip()
    if not root:
        return 'No workspace attached for this session.'
    try:
        updated = mark_steps_complete(root, record, step_ids)
    except (ValueError, OSError) as exc:
        return str(exc)
    emit_planner_progress_from_md(session, phase='executing')
    completed = [str(row.get('id') or '') for row in updated if row.get('complete')]
    pending = [str(row.get('id') or '') for row in updated if not row.get('complete')]
    return (
        f'Marked complete: {", ".join(step_ids)}. '
        f'Completed steps: {", ".join(completed) or "(none)"}. '
        f'Pending steps: {", ".join(pending) or "(none)"}.'
    )


def build_plan_tools() -> list:
    return [read_build_plan, mark_build_plan_steps_complete]


__all__ = [
    'MARK_BUILD_PLAN_STEPS_COMPLETE_NAME',
    'READ_BUILD_PLAN_NAME',
    'build_plan_tools',
    'mark_build_plan_steps_complete',
    'read_build_plan',
]
