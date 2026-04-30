"""Unit tests for SSE streaming helpers."""

from langchain_core.messages import AIMessageChunk

from nemo_backend.agent_streaming import aimessage_chunk_reasoning_delta, aimessage_chunk_sse_delta


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


def test_sse_delta_strips_tool_call_xml_from_string_content() -> None:
    chunk = AIMessageChunk(content='a<tool_call>x</tool_call>b')
    assert aimessage_chunk_sse_delta(chunk) == 'ab'


def test_sse_delta_strips_gemma_channel_tag() -> None:
    chunk = AIMessageChunk(content='<|channel> 思考过程:\n\nHi')
    assert aimessage_chunk_sse_delta(chunk) == ' 思考过程:\n\nHi'


def test_sse_delta_drops_placeholder_question_wall() -> None:
    chunk = AIMessageChunk(content='?' * 40)
    assert aimessage_chunk_sse_delta(chunk) == ''


def test_reasoning_delta_drops_placeholder_wall() -> None:
    chunk = AIMessageChunk(content='', additional_kwargs={'reasoning_content': '?' * 40})
    assert aimessage_chunk_reasoning_delta(chunk) == ''


def test_reasoning_delta_drops_single_slash_chunks() -> None:
    chunk = AIMessageChunk(content='', additional_kwargs={'reasoning_content': '/'})
    assert aimessage_chunk_reasoning_delta(chunk) == ''


def test_sse_delta_keeps_single_slash_in_main_content() -> None:
    assert aimessage_chunk_sse_delta(AIMessageChunk(content='/')) == '/'
