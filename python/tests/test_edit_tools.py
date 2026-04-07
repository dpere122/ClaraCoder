"""Registry wiring for workspace edit tools and outer agent tool surface."""

import pytest

from nemo_backend.agents.specialists.review_tools import code_review_specialist_tools
from nemo_backend.edit_tool import edit_tools_for_strict
from nemo_backend.state import get_session, runtime_config
from nemo_backend.domain import RuntimeToolsConfig
from nemo_backend.tool_registry import (
    hitl_delete_pause_tools,
    hitl_diff_pause_tools,
    worker_tools_and_map,
)


@pytest.fixture(autouse=True)
def _restore_runtime_tools():
    saved = runtime_config.tools
    yield
    runtime_config.tools = saved


def test_standard_includes_three_tools() -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    names = [t.name for t in edit_tools_for_strict(False)]
    assert names == [
        'apply_workspace_full_file',
        'replace_workspace_line_range',
        'replace_workspace_snippet',
    ]
    staging_names = {'stage_create_file', 'stage_line_range_edit', 'stage_snippet_edit'}
    transfer_names = {'approve_staged_workspace_edit', 'transfer_staged_file_to_workspace'}
    assert hitl_diff_pause_tools() == frozenset(names) | transfer_names | staging_names
    assert hitl_delete_pause_tools() == frozenset({'delete_workspace_entry'})


def test_strict_omits_snippet_tool() -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=True)
    names = [t.name for t in edit_tools_for_strict(True)]
    assert names == ['apply_workspace_full_file', 'replace_workspace_line_range']
    staging_names = {'stage_create_file', 'stage_line_range_edit', 'stage_snippet_edit'}
    transfer_names = {'approve_staged_workspace_edit', 'transfer_staged_file_to_workspace'}
    assert hitl_diff_pause_tools() == frozenset(names) | transfer_names | staging_names
    assert 'replace_workspace_snippet' not in hitl_diff_pause_tools()


def test_outer_agent_tools() -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    read_names = {'list_workspace_directory', 'read_workspace_file', 'search_workspace'}
    edit_names = {t.name for t in edit_tools_for_strict(False)}

    tools_on, map_on = worker_tools_and_map(True)
    assert {t.name for t in tools_on} == read_names | {'modify_workspace'}
    assert map_on.keys() == {t.name for t in tools_on}
    assert edit_names.isdisjoint({t.name for t in tools_on})

    tools_off, map_off = worker_tools_and_map(False)
    assert {t.name for t in tools_off} == read_names
    assert 'modify_workspace' not in map_off


def test_code_review_specialist_tools_are_staging_only() -> None:
    session = get_session('review-tools')
    session.worker_apply_mode = True
    tools, tool_map = code_review_specialist_tools()
    names = {t.name for t in tools}
    assert names == {
        'list_staged_edits',
        'read_staged_edit',
        'search_staged_edits',
        'format_staging_file_black',
        'transfer_staged_file_to_workspace',
        'reject_staged_workspace_edit',
    }
    assert tool_map.keys() == names
    assert names.isdisjoint({'list_workspace_directory', 'read_workspace_file', 'search_workspace'})
