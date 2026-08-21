"""Track in-flight Chat Completions so Stop can cancel generation without dropping the client.

LangChain/OpenAI keep the current ``/v1/chat/completions`` HTTP **request** open until
the server finishes. llama-server only stops token decode when that request's response
stream is closed. Cooperative ``abort_event`` checks stop Clara's SSE loop but do not
close that response, so GPU/CPU decode continues.

This module owns the httpx clients passed into ChatOpenAI and records live responses
via event hooks. Abort closes those response bodies only. The llama-server process,
loaded model, and reusable httpx client stay up for the next turn.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from fastapi import HTTPException

from clara_coder_backend.config import DEFAULT_LLAMACPP_BASE_URL
from clara_coder_backend.domain import SessionState

logger = logging.getLogger('clara.llm.http_transport')

_sync_client: httpx.Client | None = None
_async_client: httpx.AsyncClient | None = None
_in_flight_sync: set[httpx.Response] = set()
_in_flight_async: set[httpx.Response] = set()


def openai_v1_to_server_root(base_url: str) -> str:
    """Strip a trailing ``/v1`` so native llama-server routes (``/slots``, ``/health``) resolve."""
    url = (base_url or '').strip().rstrip('/')
    if url.lower().endswith('/v1'):
        return url[:-3]
    return url


def _is_llm_generation_request(response: httpx.Response) -> bool:
    """True for OpenAI-style completion endpoints (not health/slots/embeddings)."""
    try:
        path = str(response.request.url.path).lower()
    except Exception:
        return False
    return (
        'chat/completions' in path
        or path.rstrip('/').endswith('/completions')
        or '/responses' in path
    )


def _on_sync_response(response: httpx.Response) -> None:
    if _is_llm_generation_request(response):
        _in_flight_sync.add(response)


async def _on_async_response(response: httpx.Response) -> None:
    if _is_llm_generation_request(response):
        _in_flight_async.add(response)


def acquire_llm_http_clients(timeout: httpx.Timeout) -> tuple[httpx.Client, httpx.AsyncClient]:
    """Return process-wide httpx clients for ChatOpenAI, creating them on first use."""
    global _sync_client, _async_client
    if _sync_client is None or _sync_client.is_closed:
        _sync_client = httpx.Client(
            timeout=timeout,
            event_hooks={'response': [_on_sync_response]},
        )
    if _async_client is None or _async_client.is_closed:
        _async_client = httpx.AsyncClient(
            timeout=timeout,
            event_hooks={'response': [_on_async_response]},
        )
    return _sync_client, _async_client


async def abort_in_flight_llm_requests() -> None:
    """Close in-flight generation response streams only.

    Does not stop llama-server, unload the model, or dispose the httpx client.
    Closing the streamed Chat Completions body is what llama-server treats as cancel.
    """
    sync_resps = [r for r in _in_flight_sync]
    async_resps = [r for r in _in_flight_async]
    _in_flight_sync.clear()
    _in_flight_async.clear()
    for response in sync_resps:
        if response.is_closed:
            continue
        try:
            response.close()
        except Exception:
            logger.debug('sync LLM generation response close failed', exc_info=True)
    for response in async_resps:
        if response.is_closed:
            continue
        try:
            await asyncio.shield(response.aclose())
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug('async LLM generation response aclose failed', exc_info=True)


def _slot_is_processing(slot: Any) -> bool:
    if not isinstance(slot, dict):
        return False
    if slot.get('is_processing') is True:
        return True
    next_token = slot.get('next_token')
    return isinstance(next_token, dict) and next_token.get('has_next_token') is True


async def cancel_llama_server_slots(base_url: str, api_key: str = '') -> None:
    """Best-effort ``POST /slots/{id}?action=cancel`` for busy llama-server slots.

    Uses a short-lived client so this control call never shares the ChatOpenAI stream.
    Failures are ignored when the build does not expose slot cancel.
    """
    root = openai_v1_to_server_root(base_url)
    if not root:
        return
    headers: dict[str, str] = {'Accept': 'application/json'}
    key = (api_key or '').strip()
    if key:
        headers['Authorization'] = f'Bearer {key}'
    timeout = httpx.Timeout(connect=1.0, read=2.0, write=2.0, pool=1.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(f'{root}/slots', headers=headers)
            if res.status_code != 200:
                return
            payload = res.json()
            slots = payload if isinstance(payload, list) else []
            for slot in slots:
                if not _slot_is_processing(slot):
                    continue
                slot_id = slot.get('id')
                if slot_id is None:
                    continue
                await client.post(f'{root}/slots/{slot_id}?action=cancel', headers=headers)
    except Exception:
        logger.debug('llama-server slot cancel failed', exc_info=True)


async def abort_in_flight_generation(session: SessionState) -> None:
    """Signal the agent loop to stop and cancel the current LLM generation request."""
    session.abort_event.set()
    pause = session.agent_pause_event
    if pause is not None:
        pause.set()
    await abort_in_flight_llm_requests()
    try:
        from clara_coder_backend.session.state import get_active_connection

        connection = get_active_connection()
    except HTTPException:
        return
    if connection.provider != 'llamacpp':
        return
    await cancel_llama_server_slots(
        connection.base_url or DEFAULT_LLAMACPP_BASE_URL,
        connection.api_key,
    )
