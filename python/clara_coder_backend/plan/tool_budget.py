"""Token-budget guard for plan-mode bound tool schemas."""

from __future__ import annotations

from clara_coder_backend.domain import SessionState
from clara_coder_backend.hitl.tool_budget import TOOL_BUDGET_CAP, measure_tools
from clara_coder_backend.plan.plan_tools_registry import plan_execute_tools_and_map


def measure_plan_mode(*, session: SessionState | None = None) -> dict:
    """Measure the bound tool schema token cost for plan execution mode (with the sub-agent tools)."""
    sess = session or SessionState()
    tools, _ = plan_execute_tools_and_map(True, session=sess, include_subagent_tool=True)
    return measure_tools(tools)


def assert_plan_under_budget(cap: int = TOOL_BUDGET_CAP, *, session: SessionState | None = None) -> None:
    """Assert plan-mode tool schemas stay under ``cap``."""
    result = measure_plan_mode(session=session)
    total = result['total']
    if total <= cap:
        return
    rows = '\n'.join(f'  {name:<40} {tokens:>6}' for name, tokens in result['per_tool'])
    raise AssertionError(
        f"mode 'plan' tool schemas cost {total} tokens > cap {cap} "
        f"({result['count']} tools). Per-tool cost table (descending):\n{rows}"
    )


__all__ = ['assert_plan_under_budget', 'measure_plan_mode']
