"""Tests for LLM HTTP transport abort (Stop cancels generation, not the client)."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from clara_coder_backend.domain import SessionState
from clara_coder_backend.llm import http_transport as transport
from clara_coder_backend.session.state import current_session_id


def _run_reset() -> None:
    asyncio.run(transport.reset_llm_http_clients())


@pytest.fixture(autouse=True)
def _reset_http_transport() -> Iterator[None]:
    _run_reset()
    yield
    _run_reset()


def _async_gen_response(session_id: str) -> tuple[MagicMock, AsyncMock]:
    response = MagicMock()
    response.is_closed = False
    response.request.url.path = '/v1/chat/completions'
    response.request.extensions = {'clara_session_id': session_id}
    aclose = AsyncMock()
    response.aclose = aclose
    response.close = MagicMock()
    return response, aclose


def test_is_llm_generation_request_matches_chat_completions() -> None:
    response = MagicMock()
    response.request.url.path = '/v1/chat/completions'
    assert transport._is_llm_generation_request(response) is True
    response.request.url.path = '/health'
    assert transport._is_llm_generation_request(response) is False


@pytest.mark.asyncio
async def test_async_request_hook_stamps_current_session_id() -> None:
    token = current_session_id.set('conv-9')
    try:
        request = httpx.Request('POST', 'http://127.0.0.1:8080/v1/chat/completions')
        await transport._on_async_request(request)
        assert request.extensions['clara_session_id'] == 'conv-9'
    finally:
        current_session_id.reset(token)


@pytest.mark.asyncio
async def test_abort_session_b_does_not_close_session_a() -> None:
    timeout = httpx.Timeout(1.0)
    _sync, client = transport.acquire_llm_http_clients(timeout)
    resp_a, aclose_a = _async_gen_response('A')
    resp_b, aclose_b = _async_gen_response('B')
    await transport._on_async_response(resp_a)
    await transport._on_async_response(resp_b)

    await transport.abort_in_flight_llm_requests('B')

    aclose_b.assert_awaited_once()
    aclose_a.assert_not_awaited()
    assert client.is_closed is False
    assert transport._async_client is client


@pytest.mark.asyncio
async def test_abort_empty_session_id_is_noop() -> None:
    resp_a, aclose_a = _async_gen_response('A')
    await transport._on_async_response(resp_a)
    await transport.abort_in_flight_llm_requests('')
    await transport.abort_in_flight_llm_requests('   ')
    aclose_a.assert_not_awaited()


@pytest.mark.asyncio
async def test_finished_stream_unregisters_from_in_flight_map() -> None:
    resp, aclose = _async_gen_response('s1')
    await transport._on_async_response(resp)
    assert resp in transport._in_flight_async.get('s1', set())
    await resp.aclose()
    aclose.assert_awaited_once()
    assert resp not in transport._in_flight_async.get('s1', set())


@pytest.mark.asyncio
async def test_abort_in_flight_generation_sets_events_and_session_abort() -> None:
    session = SessionState()
    pause = asyncio.Event()
    session.agent_pause_event = pause

    with patch(
        'clara_coder_backend.llm.http_transport.abort_in_flight_llm_requests',
        new_callable=AsyncMock,
    ) as mock_abort_req:
        await transport.abort_in_flight_generation(session, 'sess-1')

    assert session.abort_event.is_set()
    assert pause.is_set()
    mock_abort_req.assert_awaited_once_with('sess-1')


@pytest.mark.asyncio
async def test_client_close_is_noop_until_reset() -> None:
    timeout = httpx.Timeout(1.0)
    sync, async_c = transport.acquire_llm_http_clients(timeout)
    sync.close()
    assert sync.is_closed is False
    await async_c.aclose()
    assert async_c.is_closed is False
    await transport.reset_llm_http_clients()
    assert sync.is_closed is True
    assert async_c.is_closed is True


@pytest.mark.asyncio
async def test_acquire_recreates_clients_when_timeout_changes() -> None:
    first = httpx.Timeout(1.0)
    second = httpx.Timeout(5.0)
    _sync1, async1 = transport.acquire_llm_http_clients(first)
    _sync2, async2 = transport.acquire_llm_http_clients(second)
    assert async1 is not async2
    _sync3, async3 = transport.acquire_llm_http_clients(second)
    assert async3 is async2
