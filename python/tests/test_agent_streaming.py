"""Unit tests for SSE streaming helpers."""

from langchain_core.messages import AIMessageChunk

from nemo_backend.agent_streaming import aimessage_chunk_sse_delta


def test_empty() -> None:
    assert aimessage_chunk_sse_delta(AIMessageChunk(content='')) == ''


def test_text() -> None:
    assert aimessage_chunk_sse_delta(AIMessageChunk(content='hello')) == 'hello'
