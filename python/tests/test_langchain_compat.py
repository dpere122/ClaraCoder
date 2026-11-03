"""Tests for :mod:`clara_coder_backend.llm.langchain_compat` OpenAI reasoning patches."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_openai import ChatOpenAI

from clara_coder_backend.llm.langchain_compat import output_was_truncated  # also installs patches on import
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


def _stream_chunk(**fields: Any) -> dict[str, Any]:
    return {'id': 'c', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'm', **fields}


@pytest.mark.asyncio(loop_scope='function')
async def test_timings_reach_the_message_once_from_the_usage_chunk() -> None:
    usage_chunk_timings = {'prompt_ms': 12.5, 'predicted_n': 5, 'predicted_per_second': 71.3}
    events = [
        # Timings on a chunk with choices as well: keeping both makes ``merge_dicts`` raise and fails the call.
        _stream_chunk(
            choices=[{'index': 0, 'delta': {'role': 'assistant', 'content': 'hi'}, 'finish_reason': 'stop'}],
            timings={'prompt_ms': 1.5, 'predicted_n': 1, 'predicted_per_second': 2.5},
        ),
        _stream_chunk(
            choices=[],
            usage={'prompt_tokens': 10, 'completion_tokens': 1, 'total_tokens': 11},
            timings=usage_chunk_timings,
        ),
    ]
    body = ''.join(f'data: {json.dumps(event)}\n\n' for event in events) + 'data: [DONE]\n\n'

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=body)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        llm = ChatOpenAI(
            model='m',
            base_url='http://mock.invalid/v1',
            api_key='dummy',
            streaming=True,
            stream_usage=True,
            max_retries=0,
            http_async_client=client,
        )
        message = await llm.ainvoke('hello')

    assert message.content == 'hi'
    assert message.response_metadata['timings'] == usage_chunk_timings
    assert message.response_metadata['finish_reason'] == 'stop'


@pytest.mark.parametrize(
    ('metadata', 'truncated'),
    [
        ({'finish_reason': 'length'}, True),
        ({'stop_reason': 'max_tokens'}, True),
        ({'finish_reason': 'stop'}, False),
        ({'finish_reason': 'tool_calls'}, False),
        ({'stop_reason': 'end_turn'}, False),
        ({}, False),
    ],
)
def test_output_was_truncated(metadata: dict[str, str], truncated: bool) -> None:
    assert output_was_truncated(AIMessage(content='partial', response_metadata=metadata)) is truncated
