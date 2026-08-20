"""Tests for Gemma 4 ``<|channel>`` output parsing and native tool-call extraction."""

from clara_coder_backend.llm.gemma_output import (
    GemmaStreamSplitter,
    extract_gemma_native_tool_calls,
    split_gemma_channels,
)
from clara_coder_backend.llm.messages import text_uses_pseudo_tool_markup


def test_split_thought_then_answer() -> None:
    raw = "<|channel>thought\nI'm\nthinking<channel|>Hello, world!"
    visible, reasoning = split_gemma_channels(raw)
    assert reasoning == "I'm\nthinking"
    assert visible == "Hello, world!"


def test_split_interleaved_thought_and_tool_call() -> None:
    raw = (
        "<|channel>thought\nplanning<channel|>"
        "<|tool_call>call:read_workspace_file{path:<|\"|>a.py<|\"|>} "
        "done"
    )
    visible, reasoning = split_gemma_channels(raw)
    assert reasoning == "planning"
    assert "<|tool_call>" in visible
    assert "done" in visible


def test_split_empty_thought_block() -> None:
    raw = "<|channel>thought\n<channel|>Answer only."
    visible, reasoning = split_gemma_channels(raw)
    assert reasoning == ""
    assert visible == "Answer only."


def test_split_strips_turn_tokens() -> None:
    raw = "<|turn>model\n<|channel>thought\nx<channel|>hi"
    visible, reasoning = split_gemma_channels(raw)
    assert reasoning == "x"
    assert visible == "hi"
    assert "<|turn>" not in visible


def test_split_passthrough_without_markers() -> None:
    assert split_gemma_channels("plain answer") == ("plain answer", "")


def test_stream_splitter_incremental() -> None:
    splitter = GemmaStreamSplitter()
    main, reason = splitter.feed("<|channel>thought\nstep")
    assert main == ""
    assert reason == "step"
    main2, reason2 = splitter.feed(" one<channel|>Hi")
    assert main2 == "Hi"
    assert reason2 == " one"
    assert splitter.flush() == ("", "")


def test_stream_splitter_emits_open_channel_before_close() -> None:
    splitter = GemmaStreamSplitter()
    _, reason = splitter.feed("<|channel>thought\ntail")
    assert reason == "tail"
    assert splitter.flush() == ("", "")


def test_stream_splitter_holds_complete_native_tool_call() -> None:
    splitter = GemmaStreamSplitter()
    native = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    main, reason = splitter.feed(native + 'Visible')
    assert main == 'Visible'
    assert reason == ''
    assert '<|tool_call>' not in main


def test_stream_splitter_holds_native_tool_call_incrementally() -> None:
    splitter = GemmaStreamSplitter()
    main, reason = splitter.feed('<|tool')
    assert main == ''
    assert reason == ''
    main, reason = splitter.feed('_call>call:list_workspace_directory{relative_path:<|"|>.<|"|>}')
    assert main == ''
    main, reason = splitter.feed('<tool_call|>ok')
    assert main == 'ok'
    assert reason == ''


def test_stream_splitter_flush_drops_unclosed_tool_call() -> None:
    splitter = GemmaStreamSplitter()
    splitter.feed('<|tool_call>call:foo{x:1}')
    assert splitter.flush() == ('', '')


def test_extract_gemma_native_google_temperature_example() -> None:
    raw = '<|tool_call>call:get_current_temperature{location:<|"|>London<|"|>}<tool_call|>'
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'get_current_temperature'
    assert got[0]['args'] == {'location': 'London'}
    assert got[0]['id'] == 'gemma-tool-1'


def test_extract_gemma_native_multiple_calls() -> None:
    raw = (
        '<|tool_call>call:list_workspace_directory{relative_path:<|"|>src<|"|>}<tool_call|>'
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert [c['name'] for c in got] == ['list_workspace_directory', 'read_workspace_file']
    assert got[0]['args'] == {'relative_path': 'src'}
    assert got[1]['args'] == {'path': 'a.py'}
    assert got[1]['id'] == 'gemma-tool-2'


def test_extract_gemma_native_nested_object_args() -> None:
    raw = (
        '<|tool_call>call:write_workspace_file{relative_path:<|"|>a.py<|"|>,'
        'meta:{mode:<|"|>replace<|"|>,ok:true,count:3}}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'write_workspace_file'
    assert got[0]['args'] == {
        'relative_path': 'a.py',
        'meta': {'mode': 'replace', 'ok': True, 'count': 3},
    }


def test_extract_gemma_native_unclosed_block_returns_empty() -> None:
    raw = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}'
    assert extract_gemma_native_tool_calls(raw) == []


def test_extract_gemma_native_skips_truncated_first_keeps_later_complete() -> None:
    raw = (
        '<|tool_call>call:list_workspace_directory{relative_path:<|"|>src'
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'read_workspace_file'
    assert got[0]['args'] == {'path': 'a.py'}
    assert got[0]['id'] == 'gemma-tool-1'


def test_extract_gemma_native_skips_unclosed_first_keeps_later_complete() -> None:
    raw = (
        '<|tool_call>call:list_workspace_directory{relative_path:<|"|>src<|"|>}'
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'read_workspace_file'
    assert got[0]['args'] == {'path': 'a.py'}
    assert got[0]['id'] == 'gemma-tool-1'


def test_extract_gemma_native_after_thought_channel() -> None:
    raw = (
        "<|channel>thought\nI should read a.py next.\n<channel|>"
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'read_workspace_file'
    assert got[0]['args'] == {'path': 'a.py'}


def test_extract_gemma_native_inside_thought_channel() -> None:
    raw = (
        "<|channel>thought\n"
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>\n'
        '<channel|>Visible briefing'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'read_workspace_file'


def test_extract_gemma_native_allows_whitespace_after_open_tag() -> None:
    raw = '<|tool_call>\ncall:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'read_workspace_file'
    assert got[0]['args'] == {'path': 'a.py'}


def test_text_uses_pseudo_tool_markup_detects_gemma_native() -> None:
    leftover = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}'
    assert text_uses_pseudo_tool_markup(leftover) is True
    assert text_uses_pseudo_tool_markup('plain answer') is False
