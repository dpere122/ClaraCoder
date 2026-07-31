"""SSE read-tool preview chunks for workspace read tools."""

from __future__ import annotations

from clara_coder_backend.agent_streaming import iter_read_tool_stream_sse


def test_iter_read_tool_stream_sse_emits_tool_read_chunks() -> None:
    lines = list(iter_read_tool_stream_sse('read_workspace_file', 'line one\nline two\n'))
    assert lines
    joined = ''.join(
        __import__('json').loads(line.removeprefix('data: ').strip())['delta']
        for line in lines
        if line.startswith('data: ')
    )
    assert '── read_workspace_file ──' in joined
    assert 'line two' in joined


def test_iter_read_tool_stream_sse_includes_read_staged_edit() -> None:
    lines = list(iter_read_tool_stream_sse('read_staged_edit', 'draft\n'))
    assert lines
    payload = __import__('json').loads(lines[0].removeprefix('data: ').strip())
    assert payload['type'] == 'tool_read_chunk'


def test_iter_read_tool_stream_sse_skips_unknown_tools() -> None:
    assert list(iter_read_tool_stream_sse('write_workspace_file', 'x')) == []
