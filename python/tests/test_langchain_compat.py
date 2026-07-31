"""Tests for :mod:`clara_coder_backend.llm.langchain_compat` OpenAI reasoning patches."""

from __future__ import annotations

from langchain_core.messages import AIMessageChunk

import clara_coder_backend.llm.langchain_compat  # noqa: F401 — installs patches on import
from langchain_openai.chat_models import base as lc_openai_base


def test_convert_delta_to_message_chunk_preserves_reasoning_content() -> None:
    chunk = lc_openai_base._convert_delta_to_message_chunk(
        {'role': 'assistant', 'content': '', 'reasoning_content': 'partial'},
        AIMessageChunk,
    )
    assert isinstance(chunk, AIMessageChunk)
    assert chunk.additional_kwargs.get('reasoning_content') == 'partial'


def test_convert_delta_to_message_chunk_preserves_reasoning_alias() -> None:
    chunk = lc_openai_base._convert_delta_to_message_chunk(
        {'role': 'assistant', 'content': '', 'reasoning': 'cot'},
        AIMessageChunk,
    )
    assert isinstance(chunk, AIMessageChunk)
    assert chunk.additional_kwargs.get('reasoning') == 'cot'


def test_convert_delta_to_message_chunk_merges_with_plain_content() -> None:
    chunk = lc_openai_base._convert_delta_to_message_chunk(
        {'role': 'assistant', 'content': 'hi', 'reasoning_content': 'think'},
        AIMessageChunk,
    )
    assert isinstance(chunk, AIMessageChunk)
    assert chunk.content == 'hi'
    assert chunk.additional_kwargs.get('reasoning_content') == 'think'


def test_convert_delta_to_message_chunk_coerces_reasoning_list() -> None:
    chunk = lc_openai_base._convert_delta_to_message_chunk(
        {'role': 'assistant', 'content': '', 'reasoning_content': ['a', 'b']},
        AIMessageChunk,
    )
    assert isinstance(chunk, AIMessageChunk)
    assert chunk.additional_kwargs.get('reasoning_content') == 'ab'
