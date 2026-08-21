"""Tests for LLM HTTP transport abort (Stop cancels generation, not the client)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from clara_coder_backend.domain import RuntimeConnection, SessionState
from clara_coder_backend.llm import http_transport as transport


def _llamacpp_conn(**kwargs: object) -> RuntimeConnection:
    base = dict(
        id='l',
        name='l',
        provider='llamacpp',
        base_url='http://127.0.0.1:8080/v1',
        model='local',
        api_key='not-needed',
        temperature=0.0,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
    )
    base.update(kwargs)
    return RuntimeConnection(**base)


def test_openai_v1_to_server_root_strips_v1() -> None:
    assert transport.openai_v1_to_server_root('http://127.0.0.1:8080/v1') == 'http://127.0.0.1:8080'
    assert transport.openai_v1_to_server_root('http://127.0.0.1:8080/v1/') == 'http://127.0.0.1:8080'
    assert transport.openai_v1_to_server_root('http://127.0.0.1:8080') == 'http://127.0.0.1:8080'


def test_is_llm_generation_request_matches_chat_completions() -> None:
    response = MagicMock()
    response.request.url.path = '/v1/chat/completions'
    assert transport._is_llm_generation_request(response) is True
    response.request.url.path = '/health'
    assert transport._is_llm_generation_request(response) is False


@pytest.mark.asyncio
async def test_abort_closes_generation_response_not_the_http_client() -> None:
    timeout = httpx.Timeout(1.0)
    _sync, client = transport.acquire_llm_http_clients(timeout)
    response = MagicMock()
    response.is_closed = False
    response.aclose = AsyncMock()
    transport._in_flight_async.add(response)

    await transport.abort_in_flight_llm_requests()

    response.aclose.assert_awaited_once()
    assert client.is_closed is False
    assert transport._async_client is client


@pytest.mark.asyncio
async def test_cancel_llama_server_slots_posts_cancel_for_busy_slots() -> None:
    slots = [
        {'id': 0, 'is_processing': True},
        {'id': 1, 'is_processing': False},
        {'id': 2, 'next_token': {'has_next_token': True}},
    ]
    get_res = MagicMock()
    get_res.status_code = 200
    get_res.json.return_value = slots
    post_res = MagicMock()
    post_res.status_code = 200
    fake_client = AsyncMock()
    fake_client.get = AsyncMock(return_value=get_res)
    fake_client.post = AsyncMock(return_value=post_res)
    fake_client.__aenter__.return_value = fake_client
    fake_client.__aexit__.return_value = False

    with patch('clara_coder_backend.llm.http_transport.httpx.AsyncClient', return_value=fake_client):
        await transport.cancel_llama_server_slots('http://127.0.0.1:8080/v1', 'not-needed')

    fake_client.get.assert_awaited_once()
    assert fake_client.get.await_args.args[0] == 'http://127.0.0.1:8080/slots'
    posted = [call.args[0] for call in fake_client.post.await_args_list]
    assert posted == [
        'http://127.0.0.1:8080/slots/0?action=cancel',
        'http://127.0.0.1:8080/slots/2?action=cancel',
    ]


@pytest.mark.asyncio
async def test_abort_in_flight_generation_sets_event_cancels_request_and_slots() -> None:
    session = SessionState()
    pause = asyncio.Event()
    session.agent_pause_event = pause

    with (
        patch(
            'clara_coder_backend.llm.http_transport.abort_in_flight_llm_requests',
            new_callable=AsyncMock,
        ) as mock_abort_req,
        patch(
            'clara_coder_backend.llm.http_transport.cancel_llama_server_slots',
            new_callable=AsyncMock,
        ) as mock_slots,
        patch(
            'clara_coder_backend.session.state.get_active_connection',
            return_value=_llamacpp_conn(),
        ),
    ):
        await transport.abort_in_flight_generation(session)

    assert session.abort_event.is_set()
    assert pause.is_set()
    mock_abort_req.assert_awaited_once()
    mock_slots.assert_awaited_once_with('http://127.0.0.1:8080/v1', 'not-needed')
