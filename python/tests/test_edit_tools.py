"""Registry wiring for workspace edit tools and outer agent tool surface."""

import pytest

from nemo_backend.agents.specialists.project_review_tools import project_review_specialist_tools
from nemo_backend.agents.specialists.review_tools import code_review_specialist_tools
from nemo_backend.agents.specialists.tools import (
    create_specialist_tools,
    report_insufficient_workspace_recon,
    update_specialist_tools,
    write_specialist_tools,
)
from nemo_backend.edit_tool import apply_workspace_full_file, replace_workspace_line_range
from nemo_backend.lsp.file_policy import outer_workspace_edit_guard_error
from nemo_backend.state import current_session_id, get_session, runtime_config, sessions
from nemo_backend.domain import RuntimeToolsConfig
from nemo_backend.node_dependency_agent import node_dependency_tools
from nemo_backend.python_dependency_agent import python_dependency_tools
from nemo_backend.python_env_tools import ensure_python_workspace_env_tool
from nemo_backend.tool_registry import (
    hitl_copy_pause_tools,
    hitl_delete_pause_tools,
    hitl_diff_pause_tools,
    staging_workspace_write_tools,
    worker_tools_and_map,
)


@pytest.fixture(autouse=True)
def _restore_runtime_tools():
    saved = runtime_config.tools
    yield
    runtime_config.tools = saved


def test_standard_includes_staging_write_tools() -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    names = [t.name for t in staging_workspace_write_tools(False)]
    assert names == [
        'stage_create_file',
        'stage_workspace_file_overwrite',
        'stage_line_range_edit',
        'stage_snippet_edit',
    ]
    lsp_mut = {'lsp_create_python_file', 'lsp_update_python_file'}
    transfer_names = {'transfer_staged_file_to_workspace'}
    staging_review_names = {'reject_staged_workspace_edit', 'format_staging_file_black', 'format_staging_file_prettier'}
    assert hitl_diff_pause_tools() == frozenset(names) | transfer_names | staging_review_names | lsp_mut
    assert hitl_delete_pause_tools() == frozenset(
        {'batch_delete_workspace_entries', 'delete_workspace_entry', 'lsp_delete_python_file'}
    )
    assert hitl_copy_pause_tools() == frozenset({'copy_workspace_files'})


def test_strict_omits_snippet_tool() -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=True)
    names = [t.name for t in staging_workspace_write_tools(True)]
    assert names == ['stage_create_file', 'stage_workspace_file_overwrite', 'stage_line_range_edit']
    lsp_mut = {'lsp_create_python_file', 'lsp_update_python_file'}
    transfer_names = {'transfer_staged_file_to_workspace'}
    staging_review_names = {'reject_staged_workspace_edit', 'format_staging_file_black', 'format_staging_file_prettier'}
    assert hitl_diff_pause_tools() == frozenset(names) | transfer_names | staging_review_names | lsp_mut
    assert 'stage_snippet_edit' not in hitl_diff_pause_tools()
    assert hitl_copy_pause_tools() == frozenset({'copy_workspace_files'})


def test_replace_workspace_line_range_accepts_new_content_alias(tmp_path) -> None:
    """Regression: LM Studio / Qwen sometimes uses `new_content` for line-range replace."""
    session_id = 'line-range-alias'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        session.worker_apply_mode = True
        session.auto_apply_mode = True
        (root / 'data.txt').write_text('a\nb\nc\n', encoding='utf-8')
        out = replace_workspace_line_range.invoke(
            {
                'relative_path': 'data.txt',
                'start_line': 2,
                'end_line': 2,
                'new_snippet': '',
                'new_content': 'B\n',
                'encoding': 'utf-8',
                'newline': 'lf',
            }
        )
        assert 'Auto-applied' in out
        assert (root / 'data.txt').read_text(encoding='utf-8') == 'a\nB\nc\n'
    finally:
        current_session_id.reset(token)


def test_outer_agent_tools() -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    read_names = {
        'list_workspace_directory',
        'read_workspace_file',
        'search_workspace',
        'retrieve_workspace_semantic',
        'lsp_get_diagnostics',
        'lsp_hover',
        'lsp_find_definition',
        'lsp_find_references',
        'lsp_get_document_symbols',
    }
    edit_names = {t.name for t in staging_workspace_write_tools(False)}
    lsp_py_mut_names = {'lsp_create_python_file', 'lsp_update_python_file', 'lsp_delete_python_file'}
    dep_names = {t.name for t in python_dependency_tools()[0]}
    node_dep_names = {t.name for t in node_dependency_tools()[0]}
    env_names = {ensure_python_workspace_env_tool.name}
    review_names = {t.name for t in code_review_specialist_tools()[0]}

    outer_verify_names = {'run_workspace_pytest_tests', 'run_workspace_python_smoke_test'}

    tools_on, map_on = worker_tools_and_map(True)
    assert {t.name for t in tools_on} == (
        read_names
        | {'copy_workspace_files'}
        | edit_names
        | lsp_py_mut_names
        | dep_names
        | node_dep_names
        | env_names
        | {'delete_workspace_entry', 'batch_delete_workspace_entries'}
        | review_names
        | outer_verify_names
    )
    assert map_on.keys() == {t.name for t in tools_on}

    tools_off, map_off = worker_tools_and_map(False)
    assert {t.name for t in tools_off} == read_names
    assert 'plan_and_modify' not in map_off
    assert 'execute_workspace_mutation' not in map_off


def test_worker_tools_merge_preserves_canonical_objects_for_replaced_names() -> None:
    """Later merge layers must re-use the same tool objects as python/node deps and LSP reads (no forked descriptions)."""
    from nemo_backend.lsp.tools import lsp_get_diagnostics
    from nemo_backend.node_dependency_agent import install_npm_packages_tool
    from nemo_backend.python_dependency_agent import install_python_packages_tool

    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    _tools, mapping = worker_tools_and_map(True)
    assert mapping['lsp_get_diagnostics'] is lsp_get_diagnostics
    assert mapping['install_python_packages'] is install_python_packages_tool
    assert mapping['install_npm_packages'] is install_npm_packages_tool


def test_outer_workspace_edit_guard_blocks_code_extensions() -> None:
    assert outer_workspace_edit_guard_error('src/foo.py') is not None
    assert outer_workspace_edit_guard_error('app.tsx') is not None
    assert outer_workspace_edit_guard_error('docs/readme.md') is None
    assert outer_workspace_edit_guard_error('package.json') is not None
    assert outer_workspace_edit_guard_error('helm/values.yaml') is not None


def test_apply_workspace_full_file_rejects_python_path(tmp_path) -> None:
    session_id = 'guard-py'
    token = current_session_id.set(session_id)
    try:
        root = tmp_path / 'ws'
        root.mkdir()
        session = get_session(session_id)
        session.workspace_path = str(root.resolve())
        session.worker_apply_mode = True
        (root / 'a.py').write_text('x=1\n', encoding='utf-8')
        out = apply_workspace_full_file.invoke(
            {'relative_path': 'a.py', 'new_content': 'x = 1\n', 'encoding': 'utf-8', 'newline': 'lf'}
        )
        assert 'Tool error:' in out
        assert 'stage_' in out or 'transfer_staged_file_to_workspace' in out
    finally:
        current_session_id.reset(token)


def test_code_review_specialist_tools_are_staging_only() -> None:
    session = get_session('review-tools')
    session.worker_apply_mode = True
    tools, tool_map = code_review_specialist_tools()
    names = {t.name for t in tools}
    assert names == {
        'list_staged_edits',
        'diff_staged_edit_against_baseline',
        'read_staged_edit',
        'search_staged_edits',
        'lsp_get_diagnostics',
        'format_staging_file_black',
        'format_staging_file_prettier',
        'run_staging_overlay_command',
        'transfer_staged_file_to_workspace',
        'reject_staged_workspace_edit',
    }
    assert tool_map.keys() == names
    assert names.isdisjoint({'list_workspace_directory', 'read_workspace_file', 'search_workspace'})


def test_project_review_specialist_tools_include_workspace_tests() -> None:
    tools, tool_map = project_review_specialist_tools()
    names = {t.name for t in tools}
    assert names == {
        'list_workspace_directory',
        'read_workspace_file',
        'search_workspace',
        'retrieve_workspace_semantic',
        'lsp_get_diagnostics',
        'lsp_hover',
        'lsp_find_definition',
        'lsp_find_references',
        'lsp_get_document_symbols',
        'ensure_python_workspace_env',
        'install_python_packages',
        'install_python_requirements_file',
        'freeze_python_requirements',
        'write_frozen_python_requirements_file',
        'install_npm_packages',
        'npm_install_project',
        'remove_npm_packages',
        'run_npm_script',
        'run_workspace_python_smoke_test',
        'run_workspace_pytest_tests',
        'approve_project_review',
        'reject_project_review',
    }
    assert tool_map.keys() == names


def test_update_specialist_uses_full_file_overwrite_only() -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    tools, tool_map = update_specialist_tools(False)
    names = [t.name for t in tools]
    assert names == [
        'read_staged_edit',
        'read_workspace_file',
        'lsp_update_python_file',
        'stage_workspace_file_overwrite',
    ]
    assert tool_map.keys() == {
        'read_staged_edit',
        'read_workspace_file',
        'lsp_update_python_file',
        'stage_workspace_file_overwrite',
    }


def test_create_specialist_includes_read_and_discovery_tools() -> None:
    tools, tool_map = create_specialist_tools()
    names = [t.name for t in tools]
    assert names == [
        'read_staged_edit',
        'list_workspace_directory',
        'retrieve_workspace_semantic',
        'search_workspace',
        'read_workspace_file',
        'lsp_create_python_file',
        'stage_create_file',
    ]
    assert tool_map.keys() == set(names)


def test_write_specialist_tools_unions_create_and_update_surfaces() -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    from nemo_backend.agents.specialists.tools import staging_author_tools, workspace_recon_tools

    recon, _ = workspace_recon_tools()
    author, _ = staging_author_tools(False)
    recon_names = [t.name for t in recon]
    author_names = [t.name for t in author]
    assert recon_names == [
        'list_workspace_directory',
        'retrieve_workspace_checkpoint_semantic',
        'search_workspace',
        'read_workspace_file',
        'lsp_get_diagnostics',
        'lsp_hover',
        'lsp_find_definition',
        'lsp_find_references',
        'lsp_get_document_symbols',
    ]
    assert author_names == [
        'read_staged_edit',
        'report_insufficient_workspace_recon',
        'lsp_create_python_file',
        'lsp_update_python_file',
        'stage_create_file',
        'stage_workspace_file_overwrite',
        'stage_line_range_edit',
        'stage_snippet_edit',
        'format_staging_file_black',
        'format_staging_file_prettier',
        'lsp_get_diagnostics',
    ]
    tools, tool_map = write_specialist_tools(False)
    assert [t.name for t in tools] == recon_names + author_names
    assert tool_map.keys() == set(recon_names + author_names)


def test_report_insufficient_workspace_recon_sets_session_field() -> None:
    sid = 'test-sid-recon-supplement-tool'
    sessions.pop(sid, None)
    get_session(sid)
    token = current_session_id.set(sid)
    try:
        out = report_insufficient_workspace_recon.invoke({'what_is_missing': 'callers of foo in `b.py`'})
        assert 'Recorded' in str(out)
        assert get_session(sid).write_recon_supplement_request == 'callers of foo in `b.py`'
        err = report_insufficient_workspace_recon.invoke({'what_is_missing': '  \n  '})
        assert 'Tool error' in str(err)
    finally:
        current_session_id.reset(token)
        sessions.pop(sid, None)
