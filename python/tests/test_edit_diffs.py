"""Per-call edit diffs sent to the UI with the finished tool status."""

from __future__ import annotations

import json

from langchain_core.messages import ToolMessage

from clara_coder_backend.lang_agent.langgraph_sse import GraphStreamState, sse_lines_for_graph_event
from clara_coder_backend.tools import edit_diffs
from clara_coder_backend.tools.edit_diffs import edit_unified_diff, record_edit_diff, take_edit_diff


def test_unified_diff_of_one_edit() -> None:
    diff = edit_unified_diff('src/m.py', 'a\nb\nc\n', 'a\nB\nc\nd\n')
    assert diff.splitlines() == [
        '--- a/src/m.py',
        '+++ b/src/m.py',
        '@@ -1,3 +1,4 @@',
        ' a',
        '-b',
        '+B',
        ' c',
        '+d',
    ]


def test_new_file_diffs_from_dev_null_and_no_change_is_empty() -> None:
    assert edit_unified_diff('n.txt', '', 'hi\n', existed=False).splitlines()[:3] == [
        '--- /dev/null',
        '+++ b/n.txt',
        '@@ -0,0 +1 @@',
    ]
    assert edit_unified_diff('n.txt', 'same\n', 'same\n') == ''


def test_big_diffs_are_cut_with_a_marker(monkeypatch) -> None:
    monkeypatch.setattr(edit_diffs, 'MAX_DIFF_LINES', 5)
    diff = edit_unified_diff('big.txt', '', ''.join(f'{i}\n' for i in range(20)), existed=False)
    lines = diff.splitlines()
    assert len(lines) == 6
    assert lines[-1] == '\\ Diff cut: 18 more lines (+18 -0)'


def test_cut_marker_counts_both_sides(monkeypatch) -> None:
    monkeypatch.setattr(edit_diffs, 'MAX_DIFF_LINES', 4)
    old = ''.join(f'old {i}\n' for i in range(3))
    new = ''.join(f'new {i}\n' for i in range(5))
    lines = edit_unified_diff('m.txt', old, new).splitlines()
    # Headers, hunk header, one deleted row kept; 2 deletions and 5 additions cut.
    assert lines[-1] == '\\ Diff cut: 7 more lines (+5 -2)'


def test_recorded_diff_is_taken_once() -> None:
    record_edit_diff('call-x', '+x')
    record_edit_diff('', '+ignored')
    assert take_edit_diff('call-x') == '+x'
    assert take_edit_diff('call-x') == ''
    assert take_edit_diff('') == ''


def test_pending_diffs_are_bounded(monkeypatch) -> None:
    monkeypatch.setattr(edit_diffs, '_MAX_PENDING', 2)
    for i in range(3):
        record_edit_diff(f'b-{i}', f'+{i}')
    assert take_edit_diff('b-0') == ''
    assert take_edit_diff('b-2') == '+2'
    take_edit_diff('b-1')


def _status(lines: list[str]) -> dict:
    rows = [json.loads(line.removeprefix('data: ')) for line in lines]
    return next(r['status'] for r in rows if r.get('type') == 'status')


def test_finished_status_carries_the_calls_diff() -> None:
    record_edit_diff('call-7', '@@ -1 +1 @@\n-a\n+b')
    ev = {
        'event': 'on_tool_end',
        'name': 'replace_workspace_lines',
        'run_id': 'run-7',
        'data': {'output': ToolMessage(content='Updated `m.py` (line-range; 1 → 1 lines).', tool_call_id='call-7')},
    }
    status = _status(sse_lines_for_graph_event(ev, GraphStreamState(), agent_role=None, status_label='', llm_event_prefix='', llm_log_context=''))
    assert status['state'] == 'complete'
    assert status['diff'] == '@@ -1 +1 @@\n-a\n+b'
    assert take_edit_diff('call-7') == ''


def test_finished_status_without_a_diff_has_no_diff_field() -> None:
    ev = {
        'event': 'on_tool_end',
        'name': 'read_workspace_file',
        'run_id': 'run-8',
        'data': {'output': ToolMessage(content='File: a.py', tool_call_id='call-8')},
    }
    status = _status(sse_lines_for_graph_event(ev, GraphStreamState(), agent_role=None, status_label='', llm_event_prefix='', llm_log_context=''))
    assert 'diff' not in status


def test_diffs_are_kept_per_session_and_appended_per_write() -> None:
    from clara_coder_backend.session.state import current_session_id

    token = current_session_id.set('s-a')
    try:
        record_edit_diff('gemma-tool-1', '+a1')
        record_edit_diff('gemma-tool-1', '+a2')
    finally:
        current_session_id.reset(token)
    token = current_session_id.set('s-b')
    try:
        # Another session's call with the same (reused) id gets nothing.
        assert take_edit_diff('gemma-tool-1') == ''
    finally:
        current_session_id.reset(token)
    token = current_session_id.set('s-a')
    try:
        assert take_edit_diff('gemma-tool-1') == '+a1\n+a2'
    finally:
        current_session_id.reset(token)


def test_stale_diff_is_discarded_before_a_reused_id_runs() -> None:
    record_edit_diff('xml-tool-1', '+stale')
    edit_diffs.discard_edit_diff('xml-tool-1')
    assert take_edit_diff('xml-tool-1') == ''
