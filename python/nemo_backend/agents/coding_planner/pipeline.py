"""Coding planner entrypoints: delegates to :mod:`nemo_backend.agents.coding_planner.orchestrator` and re-exports helpers."""

from __future__ import annotations

from typing import Any

from nemo_backend.agents.coding_planner.orchestrator import (
    run_coding_planner_deterministic_stream,
    run_coding_planner_fast_path_stream,
    run_coding_planner_orchestrated_stream,
)
from nemo_backend.agents.coding_planner.plan_llm import run_plan_probe_llm as _run_plan_probe_llm
from nemo_backend.agents.coding_planner.planner_core import (
    scope_text_mentions_programming_paths,
    PLANNER_NO_TRANSFER_STEP_RETRY_SUFFIX as _PLANNER_NO_TRANSFER_STEP_RETRY_SUFFIX,
    FINAL_PROJECT_REVIEW_FAILURE_PREFIX as _FINAL_PROJECT_REVIEW_FAILURE_PREFIX,
    StepProxyQueue as _StepProxyQueue,
    had_new_workspace_transfer_since as _had_new_workspace_transfer_since,
    parse_plan_steps as _parse_plan_steps,
    plan_requirements_text as _plan_requirements_text,
    planner_has_incomplete_work as _planner_has_incomplete_work,
    planner_progress_snapshot as _planner_progress_snapshot,
    planner_terminal_phase as _planner_terminal_phase,
    select_step_for_execution as _select_step_for_execution,
    snapshot_workspace_applied_flags as _snapshot_workspace_applied_flags,
    task_complexity_profile as _task_complexity_profile,
    truncate_step_result as _truncate_step_result,
    validate_initial_plan_steps as _validate_initial_plan_steps,
    validate_probe_plan_steps as _validate_probe_plan_steps,
)

__all__ = [
    'scope_text_mentions_programming_paths',
    '_FINAL_PROJECT_REVIEW_FAILURE_PREFIX',
    '_PLANNER_NO_TRANSFER_STEP_RETRY_SUFFIX',
    '_StepProxyQueue',
    '_had_new_workspace_transfer_since',
    '_parse_plan_steps',
    '_plan_requirements_text',
    '_planner_has_incomplete_work',
    '_planner_progress_snapshot',
    '_planner_terminal_phase',
    '_run_plan_probe_llm',
    '_select_step_for_execution',
    '_snapshot_workspace_applied_flags',
    '_task_complexity_profile',
    '_truncate_step_result',
    '_validate_initial_plan_steps',
    '_validate_probe_plan_steps',
    'run_coding_planner_fast_path_stream',
    'run_coding_planner_orchestrated_stream',
    'run_coding_planner_stream',
]


async def run_coding_planner_stream(
    session: Any,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
    *,
    include_lsp_discovery: bool = True,
) -> str:
    """Deterministic orchestrator (replacement for the legacy LangGraph ``nemo_coding_planner`` agent)."""
    return await run_coding_planner_deterministic_stream(
        session,
        session_id,
        task_summary,
        nested_q,
        checkpointer,
        include_lsp_discovery=include_lsp_discovery,
    )
