"""Planning tool stubs: runtime intercepts these for nested router / planner execution."""

from __future__ import annotations

from langchain_core.tools import tool

PLAN_AND_MODIFY_NAME = 'plan_and_modify'
EXECUTE_WORKSPACE_MUTATION_NAME = 'execute_workspace_mutation'

NESTED_OUTER_MUTATION_TOOL_NAMES: frozenset[str] = frozenset(
    {PLAN_AND_MODIFY_NAME, EXECUTE_WORKSPACE_MUTATION_NAME}
)

__all__ = [
    'EXECUTE_WORKSPACE_MUTATION_NAME',
    'NESTED_OUTER_MUTATION_TOOL_NAMES',
    'PLAN_AND_MODIFY_NAME',
    'execute_workspace_mutation',
    'plan_and_modify',
    'PLANNING_TOOLS',
    'PLANNING_TOOL_MAP',
]


@tool(PLAN_AND_MODIFY_NAME)
def plan_and_modify(task_summary: str) -> str:
    """Use when Editor mode is on and the work needs **coding-planner discovery**, a **multi-step checklist**, and/or **final project review**.

    The runtime runs the coding planner (read/search/LSP discovery, `record_plan`, `execute_plan_step` per item) when
    enabled, then the same nested router + write/code-review specialists as `execute_workspace_mutation`. Good fit for
    multi-file work, ambiguous scope, or a **chain of verifiable steps** you want sequenced and reviewed as a unit.

    Pass a self-contained `task_summary` with the **Routing handoff** block first, then goal, paths, and minimum context
    from your **outer** reads so nested agents do not repeat discovery blindly.

    Prefer `execute_workspace_mutation` for **one** scoped create/update/delete you can hand off without a planner pass.
    When this tool returns, summarize outcomes for the user in plain language (and run outer LSP reads on touched Python
    paths before claiming the workspace is clean—see system guidance)."""
    raise RuntimeError('plan_and_modify is handled by the runtime, not invoked directly.')


@tool(EXECUTE_WORKSPACE_MUTATION_NAME)
def execute_workspace_mutation(task_summary: str) -> str:
    """Use for **one scoped source-code create/update/delete** when Editor mode is on (same staged pipeline as `plan_and_modify`, **no** coding planner).

    The nested mutation router runs immediately with your `task_summary`. Start with the **Routing handoff** block
    (Operation / Paths / Existence / Quality bar), then the precise instruction—same contract as a single
    `execute_plan_step` step. You cannot call nested edit tools from the outer agent.

    Prefer this tool (possibly **several calls in sequence**) for a **single verifiable slice** per call—easier to reason
    about than one huge handoff. Use `plan_and_modify` when you need planner-led discovery, a numbered checklist across
    multiple build actions, or final project review.

    When this tool returns, summarize outcomes for the user in plain language (and run outer LSP reads on touched Python
    paths before claiming the workspace is clean—see system guidance)."""
    raise RuntimeError('execute_workspace_mutation is handled by the runtime, not invoked directly.')


PLANNING_TOOLS = [plan_and_modify, execute_workspace_mutation]
PLANNING_TOOL_MAP = {t.name: t for t in PLANNING_TOOLS}
