"""Unit tests for SSE streaming helpers."""

from langchain_core.messages import AIMessageChunk

from clara_coder_backend.agent_streaming import (
    aimessage_chunk_reasoning_delta,
    aimessage_chunk_sse_delta,
    status_detail_one_line,
    status_event,
)


def test_empty() -> None:
    assert aimessage_chunk_sse_delta(AIMessageChunk(content='')) == ''


def test_text() -> None:
    assert aimessage_chunk_sse_delta(AIMessageChunk(content='hello')) == 'hello'


def test_reasoning_delta_from_additional_kwargs() -> None:
    chunk = AIMessageChunk(
        content='visible',
        additional_kwargs={'reasoning_content': 'step one\n'},
    )
    assert aimessage_chunk_sse_delta(chunk) == 'visible'
    assert aimessage_chunk_reasoning_delta(chunk) == 'step one\n'


def test_sse_delta_skips_tool_typed_content_blocks() -> None:
    chunk = AIMessageChunk(
        content=[
            {'type': 'text', 'text': 'Hello '},
            {'type': 'tool_use', 'name': 'x', 'input': {}},
        ],
    )
    assert aimessage_chunk_sse_delta(chunk) == 'Hello '


def test_sse_delta_passes_through_tool_call_xml_in_string_content() -> None:
    chunk = AIMessageChunk(content='a<tool_call>x</tool_call>b')
    assert aimessage_chunk_sse_delta(chunk) == 'a<tool_call>x</tool_call>b'


def test_sse_delta_raw_extract_includes_gemma_channel_markup() -> None:
    """Channel splitting happens in :mod:`langgraph_sse`; raw delta extraction is unchanged."""
    chunk = AIMessageChunk(content='<|channel>thought\n\nHi')
    assert aimessage_chunk_sse_delta(chunk) == '<|channel>thought\n\nHi'


def test_sse_delta_passes_through_placeholder_question_wall() -> None:
    chunk = AIMessageChunk(content='?' * 40)
    assert aimessage_chunk_sse_delta(chunk) == '?' * 40


def test_reasoning_delta_passes_through_placeholder_wall() -> None:
    chunk = AIMessageChunk(content='', additional_kwargs={'reasoning_content': '?' * 40})
    assert aimessage_chunk_reasoning_delta(chunk) == '?' * 40


def test_reasoning_delta_passes_through_single_slash_chunks() -> None:
    chunk = AIMessageChunk(content='', additional_kwargs={'reasoning_content': '/'})
    assert aimessage_chunk_reasoning_delta(chunk) == '/'


def test_sse_delta_keeps_single_slash_in_main_content() -> None:
    assert aimessage_chunk_sse_delta(AIMessageChunk(content='/')) == '/'


def test_status_detail_one_line_collapses_newlines() -> None:
    assert status_detail_one_line('1. First step\n2. Second step') == '1. First step 2. Second step'


def test_status_event_detail_is_one_line() -> None:
    payload = status_event('id-1', 'Planner', detail='line one\nline two', state='complete')
    assert payload['status']['detail'] == 'line one line two'
