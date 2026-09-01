"""Tests for Gemma 4 ``<|channel>`` output parsing and native tool-call extraction."""

from clara_coder_backend.llm.gemma_output import (
    GemmaStreamSplitter,
    extract_gemma_native_tool_calls,
    normalize_gemma_tool_args,
    peek_partial_native_tool_call,
    split_gemma_channels,
    strip_gemma_channel_markup,
    strip_gemma_native_tool_call_blocks,
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


def test_split_orphan_channel_close_is_reasoning() -> None:
    visible, reasoning = split_gemma_channels("Need the file next.\n<channel|>Hello!")
    assert reasoning == "Need the file next."
    assert visible == "Hello!"


def test_split_strips_turn_close_token() -> None:
    visible, reasoning = split_gemma_channels("<|channel>thought\nx<channel|>hi<turn|>\n")
    assert reasoning == "x"
    assert visible == "hi"
    assert "<turn|>" not in visible


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
    splitter.drain_tool_peeks()
    assert splitter.flush() == ('', '')
    cancelled = splitter.drain_tool_peeks()
    assert cancelled == [{'name': 'foo', 'args': {}, 'cancelled': True}]


def test_stream_splitter_implicit_channel_after_tool_prompt() -> None:
    splitter = GemmaStreamSplitter(start_in_channel=True)
    main, reason = splitter.feed('Need the file next.\n<channel|>Hello!')
    assert reason == 'Need the file next.\n'
    assert main == 'Hello!'


def test_stream_splitter_implicit_channel_streams_thought_live() -> None:
    splitter = GemmaStreamSplitter(start_in_channel=True)
    main, reason = splitter.feed('Need the ')
    assert main == ''
    assert reason == 'Need the '
    main, reason = splitter.feed('file.<channel|>Hi')
    assert reason == 'file.'
    assert main == 'Hi'


def test_stream_splitter_implicit_cancelled_by_explicit_channel() -> None:
    splitter = GemmaStreamSplitter(start_in_channel=True)
    main, reason = splitter.feed("<|channel>thought\nstep<channel|>Hi")
    assert reason == 'step'
    assert main == 'Hi'


def test_stream_splitter_implicit_cancelled_by_tool_call() -> None:
    splitter = GemmaStreamSplitter(start_in_channel=True)
    native = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    main, reason = splitter.feed(native + 'Visible')
    assert reason == ''
    assert main == 'Visible'


def test_stream_splitter_orphan_close_without_implicit() -> None:
    splitter = GemmaStreamSplitter()
    main, reason = splitter.feed('ghost thought<channel|>Answer')
    assert reason == 'ghost thought'
    assert main == 'Answer'


def test_stream_splitter_second_channel_after_first_close() -> None:
    splitter = GemmaStreamSplitter()
    main1, reason1 = splitter.feed('<|channel>thought\nfirst<channel|>vis1')
    assert reason1 == 'first'
    assert main1 == 'vis1'
    main2, reason2 = splitter.feed('<|channel>thought\nsecond<channel|>vis2')
    assert reason2 == 'second'
    assert main2 == 'vis2'


def test_stream_splitter_empty_channel_then_untagged_thought_live() -> None:
    """Empty ``<|channel>thought\\n<channel|>`` must not park later thought on main.

    GGUF completions often close thought immediately, then keep thinking without a
    second open tag until a later ``<channel|>``. Offline ``split_gemma_channels``
    recovers that span; the live splitter used to emit it as visible and drop the
    close tag.
    """
    splitter = GemmaStreamSplitter()
    main1, reason1 = splitter.feed('<|channel>thought\n<channel|>')
    assert main1 == ''
    assert reason1 == ''
    main2, reason2 = splitter.feed('I am still thinking about the file')
    assert main2 == ''
    assert reason2 == ''
    main3, reason3 = splitter.feed('<channel|>Answer')
    assert 'I am still thinking about the file' in reason3
    assert main3 == 'Answer'
    assert splitter.flush() == ('', '')


def test_stream_splitter_empty_channel_then_answer_in_same_chunk() -> None:
    splitter = GemmaStreamSplitter()
    main, reason = splitter.feed('<|channel>thought\n<channel|>Answer only.')
    assert reason == ''
    assert main == 'Answer only.'


def test_stream_splitter_empty_channel_then_answer_flushes_to_main() -> None:
    splitter = GemmaStreamSplitter()
    splitter.feed('<|channel>thought\n<channel|>')
    main, reason = splitter.feed('Answer only.')
    assert main == ''
    assert reason == ''
    assert splitter.flush() == ('Answer only.', '')


def test_stream_splitter_channel_name_token_is_not_reasoning() -> None:
    splitter = GemmaStreamSplitter()
    main1, reason1 = splitter.feed('<|channel>')
    assert main1 == ''
    assert reason1 == ''
    main2, reason2 = splitter.feed('thought\nbody<channel|>Hi')
    assert 'thought' not in reason2
    assert reason2 == 'body'
    assert main2 == 'Hi'


def test_split_empty_then_orphan_thought_before_answer() -> None:
    visible, reasoning = split_gemma_channels(
        '<|channel>thought\n<channel|>I am still thinking about the file<channel|>Answer'
    )
    assert visible == 'Answer'
    assert reasoning == 'I am still thinking about the file'


def test_split_empty_thought_then_prose_before_tool_call_is_reasoning() -> None:
    raw = (
        '<|channel>thought\n<channel|>I should list the directory next'
        '<|tool_call>call:list_workspace_directory{relative_path:<|"|>.<|"|>}<tool_call|>'
    )
    visible, reasoning = split_gemma_channels(raw)
    assert 'I should list the directory next' in reasoning
    assert 'I should list the directory next' not in visible
    assert '<|tool_call>' in visible


def test_stream_splitter_empty_channel_then_thought_before_tool_call() -> None:
    splitter = GemmaStreamSplitter()
    splitter.feed('<|channel>thought\n<channel|>')
    main, reason = splitter.feed('I should list files next')
    assert main == ''
    assert reason == ''
    native = '<|tool_call>call:list_workspace_directory{relative_path:<|"|>.<|"|>}<tool_call|>'
    main2, reason2 = splitter.feed(native)
    assert main2 == ''
    assert 'I should list files next' in reason2
    assert '<|tool_call>' not in reason2
    assert splitter.flush() == ('', '')


def test_stream_splitter_in_channel_tool_call_does_not_leak_into_thought() -> None:
    splitter = GemmaStreamSplitter(start_in_channel=True)
    main, reason = splitter.feed('Need another file ')
    assert main == ''
    assert reason == 'Need another file '
    native = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    main2, reason2 = splitter.feed(native)
    assert main2 == ''
    assert '<|tool_call>' not in f'{reason}{reason2}'
    assert splitter.flush() == ('', '')


def test_stream_splitter_thought_between_native_tool_calls() -> None:
    splitter = GemmaStreamSplitter(start_in_channel=True)
    first = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    splitter.feed('Read a.py first')
    splitter.feed(first)
    main, reason = splitter.feed('Now list the folder')
    assert main == ''
    assert 'Now list the folder' in reason
    second = '<|tool_call>call:list_workspace_directory{relative_path:<|"|>.<|"|>}<tool_call|>'
    main2, reason2 = splitter.feed(second)
    assert main2 == ''
    assert '<|tool_call>' not in f'{reason}{reason2}'
    assert splitter.flush() == ('', '')


def test_stream_splitter_peeks_multiple_native_tool_calls() -> None:
    splitter = GemmaStreamSplitter()
    raw = (
        '<|tool_call>call:list_workspace_directory{relative_path:<|"|>src<|"|>}<tool_call|>'
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    )
    splitter.feed(raw)
    names = [
        peek['name']
        for peek in splitter.drain_tool_peeks()
        if not peek.get('cancelled') and not peek.get('update')
    ]
    assert names == ['list_workspace_directory', 'read_workspace_file']


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
    assert got[1]['args'] == {'relative_path': 'a.py'}
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
    assert got[0]['args'] == {'relative_path': 'a.py'}
    assert got[0]['id'] == 'gemma-tool-1'


def test_extract_gemma_native_skips_unclosed_first_keeps_later_complete() -> None:
    raw = (
        '<|tool_call>call:list_workspace_directory{relative_path:<|"|>src<|"|>}'
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'read_workspace_file'
    assert got[0]['args'] == {'relative_path': 'a.py'}
    assert got[0]['id'] == 'gemma-tool-1'


def test_extract_gemma_native_after_thought_channel() -> None:
    raw = (
        "<|channel>thought\nI should read a.py next.\n<channel|>"
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['name'] == 'read_workspace_file'
    assert got[0]['args'] == {'relative_path': 'a.py'}


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
    assert got[0]['args'] == {'relative_path': 'a.py'}


def test_extract_gemma_native_remaps_path_and_content_aliases() -> None:
    raw = (
        '<|tool_call>call:stage_create_file{content:<|"|>print(1)<|"|>,'
        'file_path:<|"|>hello.py<|"|>}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert len(got) == 1
    assert got[0]['args'] == {'relative_path': 'hello.py', 'new_content': 'print(1)'}
    assert 'path' not in got[0]['args']
    assert 'content' not in got[0]['args']


def test_extract_gemma_native_newline_fields_without_comma() -> None:
    raw = (
        '<|tool_call>call:stage_create_file{relative_path:<|"|>a.py<|"|>\n'
        'new_content:<|"|>x = 1<|"|>}<tool_call|>'
    )
    got = extract_gemma_native_tool_calls(raw)
    assert got[0]['args'] == {'relative_path': 'a.py', 'new_content': 'x = 1'}


def test_extract_gemma_native_json_quoted_path() -> None:
    raw = '<|tool_call>call:read_workspace_file{"relative_path": "src/a.py"}<tool_call|>'
    got = extract_gemma_native_tool_calls(raw)
    assert got[0]['args'] == {'relative_path': 'src/a.py'}


def test_normalize_gemma_tool_args_prefers_relative_path() -> None:
    assert normalize_gemma_tool_args(
        {'relative_path': 'keep.py', 'path': 'ignore.py', 'content': 'x'}
    ) == {'relative_path': 'keep.py', 'new_content': 'x'}


def test_text_uses_pseudo_tool_markup_detects_gemma_native() -> None:
    leftover = '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}'
    assert text_uses_pseudo_tool_markup(leftover) is True
    assert text_uses_pseudo_tool_markup('plain answer') is False


def test_strip_gemma_native_tool_call_blocks() -> None:
    raw = (
        'before'
        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
        'after'
    )
    assert strip_gemma_native_tool_call_blocks(raw) == 'beforeafter'


def test_split_nested_channel_open_does_not_leak_into_reasoning() -> None:
    raw = (
        "<|channel>thought\nouter\n"
        "<|channel>thought\ninner<channel|>Hello!"
    )
    visible, reasoning = split_gemma_channels(raw)
    assert visible == 'Hello!'
    assert 'outer' in reasoning
    assert 'inner' in reasoning
    assert '<|channel>' not in reasoning
    assert '<channel' not in reasoning


def test_split_malformed_channel_thought_tag() -> None:
    raw = '<channel thought>\nI should read it.\n<channel|>Answer'
    visible, reasoning = split_gemma_channels(raw)
    assert visible == 'Answer'
    assert reasoning == 'I should read it.'
    assert '<channel' not in reasoning
    assert '<channel' not in visible


def test_strip_gemma_channel_markup_variants() -> None:
    assert strip_gemma_channel_markup('<|channel>thought\nplan') == 'plan'
    assert strip_gemma_channel_markup('<channel thought>plan') == 'plan'
    assert strip_gemma_channel_markup('plan<channel|>') == 'plan'


def test_stream_splitter_nested_channel_open_is_consumed() -> None:
    splitter = GemmaStreamSplitter()
    main, reason = splitter.feed(
        "<|channel>thought\nouter <|channel>thought\ninner<channel|>Hi"
    )
    assert main == 'Hi'
    assert 'outer' in reason
    assert 'inner' in reason
    assert '<|channel>' not in reason
    assert '<channel' not in reason


def test_stream_splitter_malformed_channel_thought_not_emitted() -> None:
    splitter = GemmaStreamSplitter()
    main, reason = splitter.feed('<channel thought>\nplan next<channel|>Hi')
    assert main == 'Hi'
    assert reason == 'plan next'
    assert '<channel' not in reason


def test_stream_splitter_holds_partial_malformed_channel_tag() -> None:
    splitter = GemmaStreamSplitter(start_in_channel=True)
    main, reason1 = splitter.feed('hello <channel')
    assert main == ''
    assert '<channel' not in reason1
    main, reason2 = splitter.feed(' thought> more<channel|>Hi')
    combined = f'{reason1}{reason2}'
    assert 'hello' in combined
    assert 'more' in combined
    assert main == 'Hi'
    assert '<channel' not in combined
    assert 'thought>' not in combined


def test_peek_partial_native_tool_call_waits_for_brace() -> None:
    assert peek_partial_native_tool_call('call:stage_workspace_file_overwrite') is None


def test_peek_partial_native_tool_call_name_before_path() -> None:
    got = peek_partial_native_tool_call('call:stage_workspace_file_overwrite{')
    assert got == {'name': 'stage_workspace_file_overwrite', 'args': {}}


def test_peek_partial_native_tool_call_path_while_content_streams() -> None:
    interior = (
        'call:stage_workspace_file_overwrite{relative_path:<|"|>src/app.ts<|"|>,'
        'new_content:<|"|>export const x = 1'
    )
    got = peek_partial_native_tool_call(interior)
    assert got is not None
    assert got['name'] == 'stage_workspace_file_overwrite'
    assert got['args'] == {'relative_path': 'src/app.ts'}
    assert 'new_content' not in got['args']


def test_stream_splitter_peeks_write_tool_before_close() -> None:
    splitter = GemmaStreamSplitter()
    splitter.feed('<|tool_call>call:stage_workspace_file_overwrite{')
    first = splitter.drain_tool_peeks()
    assert first == [
        {'name': 'stage_workspace_file_overwrite', 'args': {}, 'update': False},
    ]
    splitter.feed('relative_path:<|"|>src/app.ts<|"|>,new_content:<|"|>const x = 1')
    second = splitter.drain_tool_peeks()
    assert second == [
        {
            'name': 'stage_workspace_file_overwrite',
            'args': {'relative_path': 'src/app.ts'},
            'update': True,
        },
    ]
    main, reason = splitter.feed('<tool_call|>')
    assert main == ''
    assert reason == ''
    assert splitter.drain_tool_peeks() == []


def test_peek_partial_native_tool_call_file_path_alias() -> None:
    interior = (
        'call:stage_create_file{content:<|"|>print(1)<|"|>,'
        'file_path:<|"|>hello.py<|"|>'
    )
    got = peek_partial_native_tool_call(interior)
    assert got is not None
    assert got['args'] == {'relative_path': 'hello.py'}
