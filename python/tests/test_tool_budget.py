"""CI guard: each mode's bound tool schemas must stay under the 18k token cap.

Run:

    python -m pytest python/tests/test_tool_budget.py -q
"""

from __future__ import annotations

from nemo_backend.domain import SessionState
from nemo_backend.tool_budget import TOOL_BUDGET_CAP, assert_under_budget, measure_mode, measure_tools


def test_read_only_under_budget() -> None:
    assert_under_budget('read_only', cap=TOOL_BUDGET_CAP, session=SessionState())


def test_editor_under_budget() -> None:
    assert_under_budget('editor', cap=TOOL_BUDGET_CAP, session=SessionState())


def test_plan_under_budget() -> None:
    assert_under_budget('plan', cap=TOOL_BUDGET_CAP, session=SessionState())


def test_tool_budget_measures_known_tools() -> None:
    result = measure_mode('read_only', session=SessionState())
    assert result['total'] > 0
    assert result['count'] > 0
    names = [name for name, _ in result['per_tool']]
    assert 'read_workspace_file' in names
    # Sanity-check the low-level helper too: same set, same total.
    from nemo_backend.tool_registry import planner_discovery_tools_and_map

    tools, _ = planner_discovery_tools_and_map(session=SessionState())
    direct = measure_tools(tools)
    assert direct['total'] == result['total']
    assert direct['count'] == result['count']
