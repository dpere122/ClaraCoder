"""CI guard: each mode's bound tool schemas must stay under the token cap (``TOOL_BUDGET_CAP``).

Run:

    python -m pytest python/tests/test_tool_budget.py -q
"""

from __future__ import annotations

from clara_coder_backend.domain import SessionState
from clara_coder_backend.hitl.tool_budget import TOOL_BUDGET_CAP, assert_under_budget, measure_mode, measure_tools
from clara_coder_backend.plan.tool_budget import assert_plan_under_budget


def test_read_only_under_budget() -> None:
    assert_under_budget('read_only', cap=TOOL_BUDGET_CAP, session=SessionState())


def test_editor_under_budget() -> None:
    assert_under_budget('editor', cap=TOOL_BUDGET_CAP, session=SessionState())


def test_plan_under_budget() -> None:
    assert_plan_under_budget(cap=TOOL_BUDGET_CAP, session=SessionState())


def test_worst_case_web_and_formatters_under_budget(monkeypatch) -> None:
    from clara_coder_backend.domain import RuntimeToolsConfig
    from clara_coder_backend.session.state import runtime_config

    monkeypatch.setattr(
        runtime_config,
        'tools',
        RuntimeToolsConfig(
            allow_web_access=True,
            searxng_base_url='http://127.0.0.1:8080',
            enable_agent_formatters=True,
        ),
    )
    assert_under_budget('read_only', cap=TOOL_BUDGET_CAP, session=SessionState())
    assert_under_budget('editor', cap=TOOL_BUDGET_CAP, session=SessionState())


def test_tool_budget_measures_known_tools() -> None:
    result = measure_mode('read_only', session=SessionState())
    assert result['total'] > 0
    assert result['count'] > 0
    names = [name for name, _ in result['per_tool']]
    assert 'read_workspace_file' in names
    # Sanity-check the low-level helper too: same set, same total (the agent-mode Ask set).
    from clara_coder_backend.hitl.tool_registry import worker_tools_and_map

    tools, _ = worker_tools_and_map(False, session=SessionState(), include_subagent_tool=True)
    direct = measure_tools(tools)
    assert direct['total'] == result['total']
    assert direct['count'] == result['count']


def test_budget_modes_measure_with_the_subagent_tools_bound() -> None:
    for mode in ('read_only', 'editor'):
        names = [name for name, _ in measure_mode(mode, session=SessionState())['per_tool']]
        assert {'spawn_subagent', 'wait_for_subagents', 'stop_subagent'} <= set(names), mode
