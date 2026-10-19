"""Write-through workspace edit tools, per-turn journaling, and the bound tool surface."""

from __future__ import annotations

import asyncio
import time
import uuid

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from clara_coder_backend.domain import RuntimeToolsConfig, SessionState
from clara_coder_backend.hitl.deferred_tool_hitl import DEFERRED_HITL_TOOL_NAMES
from clara_coder_backend.hitl.tool_registry import (
    hitl_accept_command_pause_tools,
    hitl_delete_pause_tools,
    worker_tools_and_map,
)
from clara_coder_backend.middleware.tool_batch_middleware import ToolBatchMiddleware
from clara_coder_backend.session.state import current_tool_batch_id, runtime_config
from clara_coder_backend.tools import edit as edit_module
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


# --- Parallel tool calls on one file -------------------------------------------------------------------------


def _slow_formatter(monkeypatch) -> None:
    """Widen the read → write window so unserialized parallel edits would interleave."""

    def slow(rel: str, text: str, encoding: str) -> tuple[str, str]:
        time.sleep(0.05)
        return text, ''

    monkeypatch.setattr(edit_module, '_format_in_memory', slow)


async def _run_batch(tool_calls: list[dict]) -> list[str]:
    """Run ``tool_calls`` as one parallel batch through a real ToolNode with the batch middleware."""
    node = ToolNode(
        [write_workspace_file, replace_workspace_lines, replace_workspace_snippet],
        awrap_tool_call=ToolBatchMiddleware().awrap_tool_call,
    )
    graph = StateGraph(MessagesState)
    graph.add_node('tools', node)
    graph.add_edge(START, 'tools')
    graph.add_edge('tools', END)
    calls = [{'id': f'call-{i}', 'type': 'tool_call', **c} for i, c in enumerate(tool_calls)]
    batch = AIMessage(content='', id=f'msg-{uuid.uuid4()}', tool_calls=calls)
    out = await graph.compile().ainvoke({'messages': [batch]})
    by_id = {m.tool_call_id: str(m.content) for m in out['messages'] if isinstance(m, ToolMessage)}
    return [by_id[c['id']] for c in calls]


def _lines_call(path: str, start: int, end: int, new_content: str) -> dict:
    return {
        'name': 'replace_workspace_lines',
        'args': {'relative_path': path, 'start_line': start, 'end_line': end, 'new_content': new_content},
    }


def _snippet_call(path: str, old: str, new: str) -> dict:
    return {'name': 'replace_workspace_snippet', 'args': {'relative_path': path, 'old_snippet': old, 'new_snippet': new}}


@pytest.mark.asyncio(loop_scope='function')
async def test_parallel_snippet_edits_of_one_file_both_land(journaled, monkeypatch) -> None:
    target = journaled.workspace / 'p.txt'
    target.write_text('alpha\nbeta\ngamma\n', encoding='utf-8')
    _slow_formatter(monkeypatch)

    outs = await _run_batch([_snippet_call('p.txt', 'alpha', 'ALPHA'), _snippet_call('p.txt', 'gamma', 'GAMMA')])

    assert all(o.startswith('Updated `p.txt`') for o in outs), outs
    assert target.read_text(encoding='utf-8') == 'ALPHA\nbeta\nGAMMA\n'
    # Journaled once, with the bytes from before the batch.
    rows = _journal_rows(journaled.session)
    assert [r['beforeContent'] for r in rows] == ['alpha\nbeta\ngamma\n']


@pytest.mark.asyncio(loop_scope='function')
async def test_parallel_line_range_edits_of_one_file_apply_only_the_first(journaled, monkeypatch) -> None:
    target = journaled.workspace / 'l.txt'
    target.write_text('one\ntwo\nthree\n', encoding='utf-8')
    _slow_formatter(monkeypatch)

    outs = await _run_batch([_lines_call('l.txt', 1, 1, 'zero\none\n'), _lines_call('l.txt', 3, 3, 'THREE\n')])

    # Whichever call ran second is refused, so its line number never lands on the shifted file.
    refused = [o for o in outs if 'another tool call in this same response already changed `l.txt`' in o]
    assert len(refused) == 1, outs
    assert 'read_workspace_file' in refused[0]
    assert target.read_text(encoding='utf-8') in ('zero\none\ntwo\nthree\n', 'one\ntwo\nTHREE\n')


def test_line_range_edit_after_a_snippet_edit_in_the_same_batch_is_refused(journaled) -> None:
    target = journaled.workspace / 'm.txt'
    target.write_text('one\ntwo\n', encoding='utf-8')
    token = current_tool_batch_id.set('batch-1')
    try:
        first = replace_workspace_snippet.invoke(_snippet_call('m.txt', 'one\n', 'zero\none\n')['args'])
        out = replace_workspace_lines.invoke(_lines_call('m.txt', 2, 2, 'TWO\n')['args'])
    finally:
        current_tool_batch_id.reset(token)

    assert first.startswith('Updated'), first
    assert 'your line numbers no longer match the file' in out
    assert target.read_text(encoding='utf-8') == 'zero\none\ntwo\n'


@pytest.mark.asyncio(loop_scope='function')
async def test_parallel_whole_file_rewrites_of_one_file_keep_the_first(journaled, monkeypatch) -> None:
    _slow_formatter(monkeypatch)

    outs = await _run_batch(
        [
            {'name': 'write_workspace_file', 'args': {'relative_path': 'w.txt', 'content': 'first\n'}},
            {'name': 'write_workspace_file', 'args': {'relative_path': 'w.txt', 'content': 'second\n'}},
        ]
    )

    created = [o for o in outs if o.startswith('Created `w.txt`')]
    refused = [o for o in outs if 'rewriting the whole file now would discard that change' in o]
    assert len(created) == 1 and len(refused) == 1, outs
    expected = 'first\n' if outs[0].startswith('Created') else 'second\n'
    assert (journaled.workspace / 'w.txt').read_text(encoding='utf-8') == expected


@pytest.mark.asyncio(loop_scope='function')
async def test_line_range_edit_in_a_later_batch_still_applies(journaled) -> None:
    target = journaled.workspace / 'n.txt'
    target.write_text('one\ntwo\n', encoding='utf-8')

    first = await _run_batch([_lines_call('n.txt', 1, 1, 'ONE\n')])
    second = await _run_batch([_lines_call('n.txt', 2, 2, 'TWO\n')])

    assert first[0].startswith('Updated') and second[0].startswith('Updated'), (first, second)
    assert target.read_text(encoding='utf-8') == 'ONE\nTWO\n'


def test_sequential_line_range_edits_outside_a_batch_are_not_refused(journaled) -> None:
    target = journaled.workspace / 's.txt'
    target.write_text('one\ntwo\n', encoding='utf-8')

    replace_workspace_lines.invoke(_lines_call('s.txt', 1, 1, 'ONE\n')['args'])
    out = replace_workspace_lines.invoke(_lines_call('s.txt', 2, 2, 'TWO\n')['args'])

    assert out.startswith('Updated'), out
    assert target.read_text(encoding='utf-8') == 'ONE\nTWO\n'
