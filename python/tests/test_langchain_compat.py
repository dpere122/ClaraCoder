"""Tests for :mod:`clara_coder_backend.llm.langchain_compat` OpenAI reasoning patches."""

from __future__ import annotations

from langchain_core.messages import AIMessage, AIMessageChunk

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


def _gemini_tool_turn_chunks() -> list[AIMessageChunk]:
    """OpenRouter SSE deltas for a Gemini tool call: readable summary pieces, then an encrypted signature."""
    deltas = [
        {'role': 'assistant', 'content': '', 'reasoning_details': [
            {'type': 'reasoning.text', 'text': 'Look at ', 'format': 'google-gemini-v1', 'index': 0},
        ]},
        {'role': 'assistant', 'content': '', 'reasoning_details': [
            {'type': 'reasoning.text', 'text': 'the file.', 'format': 'google-gemini-v1', 'index': 0},
        ]},
        {'role': 'assistant', 'content': '', 'reasoning_details': [
            {'type': 'reasoning.encrypted', 'data': 'c2ln', 'id': 'tool_c1', 'format': 'google-gemini-v1', 'index': 1},
        ], 'tool_calls': [
            {'index': 0, 'id': 'c1', 'type': 'function', 'function': {'name': 'read_workspace_file', 'arguments': '{"path": "a.py"}'}},
        ]},
    ]
    return [lc_openai_base._convert_delta_to_message_chunk(d, AIMessageChunk) for d in deltas]


def test_reasoning_details_survive_chunk_merge_and_echo_on_assistant_dict() -> None:
    chunks = _gemini_tool_turn_chunks()
    merged = chunks[0]
    for c in chunks[1:]:
        merged = merged + c
    msg = AIMessage(
        content='',
        tool_calls=merged.tool_calls,
        additional_kwargs=merged.additional_kwargs,
    )
    out = lc_openai_base._convert_message_to_dict(msg)
    assert out['reasoning_details'] == [
        {'type': 'reasoning.text', 'text': 'Look at the file.', 'format': 'google-gemini-v1', 'index': 0},
        {'type': 'reasoning.encrypted', 'data': 'c2ln', 'id': 'tool_c1', 'format': 'google-gemini-v1', 'index': 1},
    ]
    assert out['tool_calls'][0]['id'] == 'c1'


def test_reasoning_details_text_feeds_thought_stream_only_without_reasoning_field() -> None:
    only_details = _gemini_tool_turn_chunks()[0]
    assert only_details.additional_kwargs.get('reasoning') == 'Look at '
    mirrored = lc_openai_base._convert_delta_to_message_chunk(
        {'role': 'assistant', 'content': '', 'reasoning': 'Look at ', 'reasoning_details': [
            {'type': 'reasoning.text', 'text': 'Look at ', 'index': 0},
        ]},
        AIMessageChunk,
    )
    assert mirrored.additional_kwargs.get('reasoning') == 'Look at '
    encrypted_only = _gemini_tool_turn_chunks()[2]
    assert 'reasoning' not in encrypted_only.additional_kwargs


def test_non_streaming_reasoning_details_round_trip() -> None:
    details = [{'type': 'reasoning.encrypted', 'data': 'c2ln', 'index': 0}]
    msg = lc_openai_base._convert_dict_to_message(
        {'role': 'assistant', 'content': None, 'reasoning_details': details, 'tool_calls': [
            {'id': 'c1', 'type': 'function', 'function': {'name': 'read_workspace_file', 'arguments': '{}'}},
        ]},
    )
    assert isinstance(msg, AIMessage)
    assert lc_openai_base._convert_message_to_dict(msg)['reasoning_details'] == details


def test_assistant_dict_without_reasoning_details_is_unchanged() -> None:
    out = lc_openai_base._convert_message_to_dict(AIMessage(content='hi'))
    assert 'reasoning_details' not in out
