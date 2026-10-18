"""Write-through workspace edit tools, per-turn journaling, and the bound tool surface."""

from __future__ import annotations

import asyncio

import pytest

from clara_coder_backend.domain import RuntimeToolsConfig, SessionState
from clara_coder_backend.hitl.deferred_tool_hitl import DEFERRED_HITL_TOOL_NAMES
from clara_coder_backend.hitl.tool_registry import (
    hitl_accept_command_pause_tools,
    hitl_delete_pause_tools,
    worker_tools_and_map,
)
from clara_coder_backend.session.state import runtime_config
from clara_coder_backend.tools.edit import (
    edit_tools,
    replace_workspace_lines,
    replace_workspace_snippet,
    write_workspace_file,
)

_REMOVED_TOOL_NAMES = {
    'stage_create_file',
    'stage_workspace_file_overwrite',
    'stage_line_range_edit',
    'stage_snippet_edit',
    'transfer_staged_file_to_workspace',
    'discard_staged_edits',
    'list_staged_edits',
    'read_staged_edit',
    'wait_for_write',
    'run_staging_overlay_command',
    'lsp_create_python_file',
    'lsp_update_typescript_file',
    'lsp_delete_java_file',
    'apply_workspace_full_file',
    'replace_workspace_line_range',
    'delete_workspace_entry',
    'batch_delete_workspace_entries',
    'retrieve_workspace_checkpoint_semantic',
}


def _journal_rows(session: SessionState) -> list[dict]:
    rows = []
    q = session.hitl_sse_queue
    while q is not None and not q.empty():
        kind, payload = q.get_nowait()
        if kind == 'file_journal':
            rows.append(payload)
    return rows


@pytest.fixture()
def journaled(workspace_env):
    workspace_env.session.hitl_sse_queue = asyncio.Queue()
    return workspace_env


def test_write_creates_file_with_parents_and_journals_create(journaled) -> None:
    out = write_workspace_file.invoke({'relative_path': 'pkg/sub/new.txt', 'content': 'hello\n'})

    assert out.startswith('Created `pkg/sub/new.txt`'), out
    assert (journaled.workspace / 'pkg' / 'sub' / 'new.txt').read_text(encoding='utf-8') == 'hello\n'
    rows = _journal_rows(journaled.session)
    assert [(r['op'], r['relativePath'], r['userMessageId']) for r in rows] == [('create', 'pkg/sub/new.txt', 'turn-1')]
    assert 'beforeContent' not in rows[0]


def test_only_first_write_per_turn_is_journaled(journaled) -> None:
    target = journaled.workspace / 'a.txt'
    target.write_text('one\ntwo\nthree\n', encoding='utf-8')

    replace_workspace_lines.invoke({'relative_path': 'a.txt', 'start_line': 2, 'end_line': 2, 'new_content': 'TWO\n'})
    replace_workspace_snippet.invoke({'relative_path': 'a.txt', 'old_snippet': 'three', 'new_snippet': 'THREE'})

    assert target.read_text(encoding='utf-8') == 'one\nTWO\nTHREE\n'
    rows = _journal_rows(journaled.session)
    assert len(rows) == 1
    assert rows[0]['op'] == 'modify'
    assert rows[0]['beforeContent'] == 'one\ntwo\nthree\n'

    # A new turn journals the path again with the bytes that turn started from.
    journaled.session.current_user_message_id = 'turn-2'
    write_workspace_file.invoke({'relative_path': 'a.txt', 'content': 'rewritten\n'})
    rows = _journal_rows(journaled.session)
    assert [(r['userMessageId'], r['beforeContent']) for r in rows] == [('turn-2', 'one\nTWO\nTHREE\n')]


def test_edits_never_pause_even_with_auto_run_off(journaled) -> None:
    journaled.session.auto_apply_mode = False
    out = write_workspace_file.invoke({'relative_path': 'x.md', 'content': '# x\n'})

    assert not out.startswith('Tool error'), out
    assert (journaled.workspace / 'x.md').is_file()
    assert journaled.session.agent_pause_event is None


def test_stale_snippet_error_points_at_reread(journaled) -> None:
    (journaled.workspace / 'b.txt').write_text('alpha\n', encoding='utf-8')
    out = replace_workspace_snippet.invoke({'relative_path': 'b.txt', 'old_snippet': 'missing', 'new_snippet': 'x'})
    assert out.startswith('Tool error:')
    assert 'read_workspace_file' in out
    assert (journaled.workspace / 'b.txt').read_text(encoding='utf-8') == 'alpha\n'


def test_snippet_requires_existing_file(journaled) -> None:
    out = replace_workspace_snippet.invoke({'relative_path': 'nope.txt', 'old_snippet': 'a', 'new_snippet': 'b'})
    assert 'write_workspace_file' in out


def test_line_range_rejects_bad_range(journaled) -> None:
    (journaled.workspace / 'c.txt').write_text('x\n', encoding='utf-8')
    out = replace_workspace_lines.invoke({'relative_path': 'c.txt', 'start_line': 3, 'end_line': 1, 'new_content': ''})
    assert out == 'Tool error: need 1 <= start_line <= end_line.'


def test_path_escape_is_a_tool_error_not_an_exception(journaled) -> None:
    out = write_workspace_file.invoke({'relative_path': '../outside.txt', 'content': 'x'})
    assert out.startswith('Tool error:')


def test_editor_off_blocks_edits(journaled) -> None:
    journaled.session.worker_apply_mode = False
    out = write_workspace_file.invoke({'relative_path': 'x.txt', 'content': 'x'})
    assert out.startswith('Tool error: Editor mode is off')


@pytest.fixture()
def _restore_runtime_tools():
    saved = runtime_config.tools
    yield
    runtime_config.tools = saved


@pytest.mark.usefixtures('_restore_runtime_tools')
def test_edit_tool_set_strict_and_formatters() -> None:
    runtime_config.tools = RuntimeToolsConfig(enable_agent_formatters=False)
    assert [t.name for t in edit_tools(strict=False)] == [
        'write_workspace_file',
        'replace_workspace_lines',
        'replace_workspace_snippet',
    ]
    assert [t.name for t in edit_tools(strict=True)] == ['write_workspace_file', 'replace_workspace_lines']
    runtime_config.tools = RuntimeToolsConfig(enable_agent_formatters=True)
    assert 'format_workspace_file' in {t.name for t in edit_tools(strict=False)}


@pytest.mark.usefixtures('_restore_runtime_tools')
@pytest.mark.parametrize('auto_run', [False, True])
def test_editor_binding_ignores_auto_run(auto_run: bool) -> None:
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    session = SessionState()
    session.auto_apply_mode = auto_run
    names = {t.name for t in worker_tools_and_map(True, session=session)[0]}

    assert {'write_workspace_file', 'replace_workspace_lines', 'delete_workspace_entries', 'run_command'} <= names
    assert not names & _REMOVED_TOOL_NAMES


def test_read_only_binding_has_no_mutators() -> None:
    names = {t.name for t in worker_tools_and_map(False, session=SessionState())[0]}
    assert 'read_workspace_file' in names
    assert 'write_workspace_file' not in names
    assert 'run_command' not in names


def test_hitl_pause_sets() -> None:
    assert hitl_delete_pause_tools() == frozenset({'delete_workspace_entries'})
    assert DEFERRED_HITL_TOOL_NAMES <= hitl_accept_command_pause_tools()
    assert 'run_staging_overlay_command' not in DEFERRED_HITL_TOOL_NAMES
