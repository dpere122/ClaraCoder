"""Claude source: ChatAnthropic request shape, effort choice, thinking blocks, Stop matching."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.lang_agent.streaming import aimessage_chunk_reasoning_delta
from clara_coder_backend.llm.anthropic_llm import (
    THINKING_BINDING_BETA,
    ClaraChatAnthropic,
    build_anthropic_llm,
    resolve_anthropic_effort,
)
from clara_coder_backend.llm.http_transport import _is_llm_generation_request
from clara_coder_backend.llm.messages import final_assistant_text, reasoning_sidecar_text, stringify_content

OPUS_CAPS = {
    'enableThinking': False,
    'reasoningEffortValues': ['low', 'medium', 'high', 'xhigh', 'max'],
    'adaptiveThinking': True,
}


def _connection(**overrides: object) -> RuntimeConnection:
    base: dict[str, object] = {
        'id': 'default-anthropic',
        'name': 'Claude Opus 5.5',
        'provider': 'anthropic',
        'base_url': '',
        'model': 'claude-opus-5-5',
        'api_key': 'sk-ant-test-key',
        'temperature': 0.7,
        'chat_template_reasoning': dict(OPUS_CAPS),
    }
    base.update(overrides)
    return RuntimeConnection(**base)  # type: ignore[arg-type]


def _payload(llm: ClaraChatAnthropic) -> dict[str, object]:
    return llm._get_request_payload([HumanMessage(content='hi')])


def test_adaptive_model_sends_summarized_thinking_with_drop_block_and_caching() -> None:
    llm = build_anthropic_llm(_connection(), idle_timeout_sec=120)
    payload = _payload(llm)

    assert payload['model'] == 'claude-opus-5-5'
    assert payload['thinking'] == {
        'type': 'adaptive',
        'display': 'summarized',
        'block_binding': {'prefix_mismatch_behavior': 'drop_block'},
    }
    assert THINKING_BINDING_BETA in payload['betas']  # type: ignore[operator]
    assert payload['cache_control'] == {'type': 'ephemeral'}
    assert payload['output_config'] == {'effort': 'medium'}
    assert payload['max_tokens'] == 64_000
    # Current Claude models reject sampling parameters; Settings' temperature must not leak through.
    assert 'temperature' not in payload
    assert 'top_p' not in payload


def test_saved_effort_and_max_output_are_honored() -> None:
    llm = build_anthropic_llm(_connection(reasoning_effort='xhigh', max_output_tokens=32_000), idle_timeout_sec=120)
    payload = _payload(llm)
    assert payload['output_config'] == {'effort': 'xhigh'}
    assert payload['max_tokens'] == 32_000


def test_model_without_adaptive_thinking_omits_thinking_and_beta() -> None:
    caps = {'enableThinking': False, 'reasoningEffortValues': None, 'adaptiveThinking': False}
    llm = build_anthropic_llm(_connection(model='claude-haiku-4-5', chat_template_reasoning=caps), idle_timeout_sec=120)
    payload = _payload(llm)
    assert 'thinking' not in payload
    assert 'betas' not in payload
    assert 'output_config' not in payload


def test_disable_thinking_lowers_effort_instead_of_disabling() -> None:
    llm = build_anthropic_llm(_connection(reasoning_effort='max'), idle_timeout_sec=120, disable_thinking=True)
    payload = _payload(llm)
    assert payload['output_config'] == {'effort': 'low'}
    assert payload['thinking']['type'] == 'adaptive'  # type: ignore[index]


@pytest.mark.parametrize(
    ('saved', 'allowed', 'disable', 'expected'),
    [
        ('', ['low', 'medium', 'high'], False, 'medium'),
        ('high', ['low', 'medium', 'high'], False, 'high'),
        ('max', ['low', 'medium', 'high'], False, 'medium'),
        ('', ['high', 'max'], False, 'high'),
        ('high', ['low', 'medium', 'high'], True, 'low'),
        ('high', None, False, None),
    ],
)
def test_resolve_anthropic_effort(saved: str, allowed: list[str] | None, disable: bool, expected: str | None) -> None:
    assert resolve_anthropic_effort(saved, allowed, disable_thinking=disable) == expected


def test_missing_key_or_model_is_a_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    with pytest.raises(HTTPException, match='Claude API key'):
        build_anthropic_llm(_connection(api_key=''), idle_timeout_sec=120)
    with pytest.raises(HTTPException, match='Pick a Claude model'):
        build_anthropic_llm(_connection(model=''), idle_timeout_sec=120)


def test_clients_use_owned_httpx2_pair() -> None:
    llm = build_anthropic_llm(_connection(), idle_timeout_sec=90)
    client = llm._async_client
    # The SDK keeps the http client we passed; Stop closes responses registered on its hooks.
    hooks = client._client.event_hooks
    assert hooks['response'] and hooks['request']


def test_thinking_chunks_stream_as_reasoning() -> None:
    chunk = AIMessageChunk(content=[{'type': 'thinking', 'thinking': 'Checking the tests', 'index': 0}])
    assert aimessage_chunk_reasoning_delta(chunk) == 'Checking the tests'
    text_chunk = AIMessageChunk(content=[{'type': 'text', 'text': 'Done', 'index': 1}])
    assert aimessage_chunk_reasoning_delta(text_chunk) == ''


def test_thinking_blocks_are_reasoning_not_content() -> None:
    content = [
        {'type': 'thinking', 'thinking': 'Plan: read the file.', 'signature': 'sig'},
        {'type': 'text', 'text': 'Here is the answer.'},
    ]
    message = AIMessage(content=content)
    assert stringify_content(content) == 'Here is the answer.'
    assert final_assistant_text(message) == 'Here is the answer.'
    assert reasoning_sidecar_text(message) == 'Plan: read the file.'


def test_messages_endpoint_counts_as_generation_for_stop() -> None:
    def response(path: str) -> SimpleNamespace:
        return SimpleNamespace(request=SimpleNamespace(url=SimpleNamespace(path=path)))

    assert _is_llm_generation_request(response('/v1/messages'))
    assert not _is_llm_generation_request(response('/v1/messages/count_tokens'))
    assert not _is_llm_generation_request(response('/v1/models'))


@pytest.mark.asyncio
async def test_stop_closes_a_live_claude_stream() -> None:
    import httpx2

    from clara_coder_backend.llm.http_transport import (
        abort_in_flight_llm_requests,
        acquire_anthropic_http_clients,
        reset_llm_http_clients,
    )
    from clara_coder_backend.session.state import current_session_id

    async def endless_sse():
        while True:
            yield b'event: ping\ndata: {}\n\n'

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, content=endless_sse(), headers={'content-type': 'text/event-stream'})

    await reset_llm_http_clients()
    _, client = acquire_anthropic_http_clients(30.0)
    client._transport = httpx2.MockTransport(handler)
    token = current_session_id.set('sess-stop')
    try:
        request = client.build_request('POST', 'https://api.anthropic.com/v1/messages')
        response = await client.send(request, stream=True)
        assert not response.is_closed
        await abort_in_flight_llm_requests('sess-stop')
        assert response.is_closed
    finally:
        current_session_id.reset(token)
        await reset_llm_http_clients()
