"""Tool rows of calls that never reached their tool, on the real chain with the real tools (only HTTP is fake).

The row opens while the arguments stream. Whatever keeps the tool from starting, it must not end as a finished call.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from test_context_compaction_middleware import (  # noqa: F401 (``session`` and ``workspace`` are fixtures)
    MockServer,
    _edit_results,
    _fill_with_reads,
    call_reply,
    composer_turn,
    real_graph,
    real_overhead,
    run_graph,
    session,
    set_window,
    sse_statuses,
    text_reply,
    thread,
    thread_messages,
    user_turn,
    workspace,
)

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent import graph as graph_module

pytestmark = pytest.mark.asyncio(loop_scope='function')

_CUT_OFF_ROW = ('error', 'Not run: reply hit the output limit')
_REFUSED_ROW = ('error', 'Not run')


def _final_rows(lines: list[str], label: str) -> list[tuple[str, str]]:
    """``(state, detail)`` that each tool row with this label ended on, in the order the rows opened."""
    rows: dict[str, tuple[str, str]] = {}
    for status in sse_statuses(lines):
        if status.get('source') == 'tool' and status['label'] == label:
            rows[status['id']] = (status['state'], status['detail'])
    return list(rows.values())


def _cut_off_write(call_id: str) -> dict:
    return call_reply('write_workspace_file', '{"relative_path": "new.txt", "content": "par', call_id, finish='length')


async def test_arguments_that_fail_the_schema_end_the_row_as_an_error(session: SessionState, workspace: Path) -> None:
    """``on_tool_start`` fired, so the row is the tool's; the schema error comes as ``on_tool_error``, no ``on_tool_end``."""
    server = MockServer([call_reply('read_workspace_file', '{"nonsense": "x"}', 'c1'), text_reply('recovered')])

    _state, lines, error = await run_graph(real_graph(server, session), thread(), user_turn())

    assert error is None
    [(state, detail)] = _final_rows(lines, 'read_workspace_file')
    assert state == 'error'
    assert 'relative_path' in detail
    # The model is told too, and carries on.
    tool_message = [m for m in server.requests[-1]['messages'] if m['role'] == 'tool'][-1]
    assert 'relative_path' in tool_message['content']


async def test_a_cut_off_write_does_not_read_as_written(session: SessionState, workspace: Path) -> None:
    server = MockServer([_cut_off_write('c1'), text_reply('recovered')])

    _state, lines, error = await run_graph(real_graph(server, session), thread(), user_turn())

    assert error is None
    assert not (workspace / 'new.txt').exists()
    assert _final_rows(lines, 'write_workspace_file') == [_CUT_OFF_ROW]


async def test_three_cut_off_writes_leave_no_finished_row_next_to_the_stop_text(
    session: SessionState, workspace: Path
) -> None:
    server = MockServer([_cut_off_write(f'c{i}') for i in range(3)])

    _state, lines, error = await run_graph(real_graph(server, session), thread(), user_turn())

    assert error is None
    assert session.harness_final_text.startswith('Stopped: the model hit its output limit')
    assert not (workspace / 'new.txt').exists()
    assert _final_rows(lines, 'write_workspace_file') == [_CUT_OFF_ROW] * 3


async def test_a_refused_edit_does_not_read_as_done_and_its_retry_does(session: SessionState, workspace: Path) -> None:
    set_window(real_overhead(session) + 9000)
    read_range = {'relative_path': 'notes.txt', 'start_line': 40, 'end_line': 60}
    edit = {**read_range, 'new_content': 'REFUSED'}
    server = MockServer(
        [
            call_reply('read_workspace_file', read_range, 'first-read'),
            *_fill_with_reads(12),
            call_reply('replace_workspace_lines', edit, 'e1'),
            call_reply('read_workspace_file', read_range, 'second-read'),
            call_reply('replace_workspace_lines', {**edit, 'new_content': 'ALLOWED'}, 'e2'),
            text_reply('done'),
        ]
    )
    graph = real_graph(server, session)

    _state, lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    results = _edit_results(await thread_messages(graph, thread()), 'replace_workspace_lines')
    assert 'Nothing was written' in results[0]
    assert results[1].startswith('Updated `notes.txt`')
    refused, retried = _final_rows(lines, 'replace_workspace_lines')
    assert refused == _REFUSED_ROW
    assert retried[0] == 'complete'


async def test_a_call_of_no_known_tool_does_not_read_as_done(session: SessionState, workspace: Path) -> None:
    """The tool node answers it with an error of its own, and no tool starts."""
    server = MockServer([call_reply('no_such_tool', {'relative_path': 'notes.txt'}, 'u1'), text_reply('done')])

    _state, lines, error = await run_graph(real_graph(server, session), thread(), user_turn())

    assert error is None
    assert _final_rows(lines, 'no_such_tool') == [_REFUSED_ROW]


async def test_the_call_the_step_limit_stopped_does_not_read_as_done(session: SessionState) -> None:
    """Through the composer: the graph ends with the last reply's call open, and the row's error fails nothing."""
    server = MockServer([call_reply('read_thing', {'path': str(i)}, f'c{i}') for i in range(40)])

    with patch.object(graph_module, 'MAX_AGENT_STEPS', 24):
        lines = await composer_turn(server, 'go')

    *ran, last = _final_rows(lines, 'read_thing')
    assert last == _REFUSED_ROW
    assert ran and all(row_state == 'complete' for row_state, _detail in ran)
    assert not any(status['state'] == 'error' and status['source'] == 'agent' for status in sse_statuses(lines))


async def test_a_call_that_ran_ends_on_its_own_result(session: SessionState, workspace: Path) -> None:
    edit = {'relative_path': 'notes.txt', 'start_line': 1, 'end_line': 1, 'new_content': 'LANDED'}
    server = MockServer([call_reply('replace_workspace_lines', edit, 'e1'), text_reply('done')])

    _state, lines, error = await run_graph(real_graph(server, session), thread(), user_turn())

    assert error is None
    assert 'LANDED' in (workspace / 'notes.txt').read_text(encoding='utf-8')
    [(row_state, _detail)] = _final_rows(lines, 'replace_workspace_lines')
    assert row_state == 'complete'
