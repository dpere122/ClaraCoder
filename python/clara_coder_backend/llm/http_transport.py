"""Track in-flight Chat Completions so Stop can cancel generation without dropping the client.

LangChain/OpenAI keep the current ``/v1/chat/completions`` HTTP **request** open until
the server finishes. llama-server only stops token decode when that request's response
stream is closed. Cooperative ``abort_event`` checks stop Clara's SSE loop but do not
close that response, so GPU/CPU decode continues.

This module owns the httpx clients passed into ChatOpenAI and records live responses
via event hooks, keyed by ``current_session_id``. Abort closes that session's response
bodies only. The llama-server process, loaded model, and reusable httpx client stay up
for the next turn. ChatOpenAI must not dispose the shared clients; ``close`` / ``aclose``
on the wrappers are no-ops.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
from typing import Any

import httpx

from clara_coder_backend.domain import SessionState

logger = logging.getLogger('clara.llm.http_transport')

_SESSION_EXT_KEY = 'clara_session_id'


class _OwnedSyncClient(httpx.Client):
    """Process-wide client; ChatOpenAI ``close()`` must not dispose it."""

    def close(self) -> None:
        return

    def _dispose(self) -> None:
        super().close()


class _OwnedAsyncClient(httpx.AsyncClient):
    """Process-wide async client; ChatOpenAI ``aclose()`` must not dispose it."""

    async def aclose(self) -> None:
        return

    async def _dispose(self) -> None:
        await super().aclose()


_lock = threading.Lock()
_sync_client: _OwnedSyncClient | None = None
_async_client: _OwnedAsyncClient | None = None
_client_timeout: httpx.Timeout | None = None
_in_flight_sync: dict[str, set[httpx.Response]] = {}
_in_flight_async: dict[str, set[httpx.Response]] = {}
_wrapped_response_ids: set[int] = set()


def _stamp_session_id(request: httpx.Request) -> None:
    from clara_coder_backend.session.state import current_session_id

    request.extensions[_SESSION_EXT_KEY] = current_session_id.get() or ''


def _on_sync_request(request: httpx.Request) -> None:
    _stamp_session_id(request)


async def _on_async_request(request: httpx.Request) -> None:
    _stamp_session_id(request)


def _is_llm_generation_request(response: httpx.Response) -> bool:
    """True for completion endpoints: OpenAI-style, and Claude ``/v1/messages`` (not health/slots/embeddings)."""
    try:
        path = str(response.request.url.path).lower()
    except Exception:
        return False
    return (
        'chat/completions' in path
        or path.rstrip('/').endswith('/completions')
        or '/responses' in path
        or path.rstrip('/').endswith('/v1/messages')
    )


def _session_id_from_response(response: httpx.Response) -> str:
    try:
        sid = response.request.extensions.get(_SESSION_EXT_KEY)
        if isinstance(sid, str):
            return sid
    except Exception:
        pass
    from clara_coder_backend.session.state import current_session_id

    return current_session_id.get() or ''


def _unregister(response: httpx.Response) -> None:
    with _lock:
        for bucket in (_in_flight_sync, _in_flight_async):
            empty_keys: list[str] = []
            for sid, resps in bucket.items():
                resps.discard(response)
                if not resps:
                    empty_keys.append(sid)
            for sid in empty_keys:
                bucket.pop(sid, None)


def _wrap_response_close(response: httpx.Response) -> None:
    rid = id(response)
    if rid in _wrapped_response_ids:
        return
    _wrapped_response_ids.add(rid)
    orig_close = response.close
    orig_aclose = response.aclose

    def close(*args: Any, **kwargs: Any) -> Any:
        _unregister(response)
        return orig_close(*args, **kwargs)

    async def aclose(*args: Any, **kwargs: Any) -> Any:
        _unregister(response)
        result = orig_aclose(*args, **kwargs)
        if inspect.isawaitable(result):
            return await result
        return result

    response.close = close  # type: ignore[method-assign]
    response.aclose = aclose  # type: ignore[method-assign]


def _register(response: httpx.Response, *, is_async: bool) -> None:
    if not _is_llm_generation_request(response):
        return
    session_id = _session_id_from_response(response)
    with _lock:
        bucket = _in_flight_async if is_async else _in_flight_sync
        bucket.setdefault(session_id, set()).add(response)
    _wrap_response_close(response)


def _on_sync_response(response: httpx.Response) -> None:
    _register(response, is_async=False)


async def _on_async_response(response: httpx.Response) -> None:
    _register(response, is_async=True)


def _dispose_sync_client(client: httpx.Client | None) -> None:
    if client is None:
        return
    try:
        if isinstance(client, _OwnedSyncClient):
            client._dispose()
        elif not client.is_closed:
            client.close()
    except Exception:
        logger.debug('sync LLM httpx client dispose failed', exc_info=True)


async def _dispose_async_client(client: httpx.AsyncClient | None) -> None:
    if client is None:
        return
    try:
        if isinstance(client, _OwnedAsyncClient):
            await client._dispose()
        elif not client.is_closed:
            await client.aclose()
    except Exception:
        logger.debug('async LLM httpx client dispose failed', exc_info=True)


def _dispose_async_client_soon(client: httpx.AsyncClient | None) -> None:
    """Dispose an async client from sync ``acquire`` (timeout rebuild)."""
    if client is None:
        return

    async def _go() -> None:
        await _dispose_async_client(client)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(_go())
        return
    loop.create_task(_go())


def acquire_llm_http_clients(timeout: httpx.Timeout) -> tuple[httpx.Client, httpx.AsyncClient]:
    """Return process-wide httpx clients for ChatOpenAI, creating them on first use.

    Recreates the pair when the previous clients were disposed or ``timeout`` changed.
    ``close`` / ``aclose`` on the returned objects are no-ops so ChatOpenAI cannot
    tear down the shared pool; call :func:`reset_llm_http_clients` to dispose.
    """
    global _sync_client, _async_client, _client_timeout
    if (
        _sync_client is not None
        and _async_client is not None
        and not _sync_client.is_closed
        and not _async_client.is_closed
        and _client_timeout == timeout
    ):
        return _sync_client, _async_client

    old_sync, old_async = _sync_client, _async_client
    _sync_client = _OwnedSyncClient(
        timeout=timeout,
        event_hooks={'request': [_on_sync_request], 'response': [_on_sync_response]},
    )
    _async_client = _OwnedAsyncClient(
        timeout=timeout,
        event_hooks={'request': [_on_async_request], 'response': [_on_async_response]},
    )
    _client_timeout = timeout
    _dispose_sync_client(old_sync)
    _dispose_async_client_soon(old_async)
    return _sync_client, _async_client


_anthropic_clients: tuple[Any, Any] | None = None
_anthropic_timeout: float | None = None


def acquire_anthropic_http_clients(timeout: float) -> tuple[Any, Any]:
    """Return process-wide ``httpx2`` clients for the Anthropic SDK, on the same Stop hooks.

    The Anthropic SDK only accepts ``httpx2`` clients, so it cannot share the ``httpx`` pair
    above; the hooks only touch attributes both libraries have, so Stop closes a Claude
    ``/v1/messages`` stream the same way it closes a Chat Completions one.
    """
    global _anthropic_clients, _anthropic_timeout
    if _anthropic_clients is not None and _anthropic_timeout == timeout:
        sync_c, async_c = _anthropic_clients
        if not sync_c.is_closed and not async_c.is_closed:
            return _anthropic_clients

    import httpx2

    class _OwnedSyncClient2(httpx2.Client):
        def close(self) -> None:
            return

        def _dispose(self) -> None:
            super().close()

    class _OwnedAsyncClient2(httpx2.AsyncClient):
        async def aclose(self) -> None:
            return

        async def _dispose(self) -> None:
            await super().aclose()

    old = _anthropic_clients
    pair = (
        _OwnedSyncClient2(
            timeout=timeout,
            event_hooks={'request': [_on_sync_request], 'response': [_on_sync_response]},
        ),
        _OwnedAsyncClient2(
            timeout=timeout,
            event_hooks={'request': [_on_async_request], 'response': [_on_async_response]},
        ),
    )
    _anthropic_clients = pair
    _anthropic_timeout = timeout
    if old is not None:
        _dispose_owned_pair_soon(old)
    return pair


def _dispose_owned_pair_soon(pair: tuple[Any, Any]) -> None:
    sync_c, async_c = pair
    try:
        sync_c._dispose()
    except Exception:
        logger.debug('sync anthropic httpx2 client dispose failed', exc_info=True)

    async def _go() -> None:
        try:
            await async_c._dispose()
        except Exception:
            logger.debug('async anthropic httpx2 client dispose failed', exc_info=True)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(_go())
        return
    loop.create_task(_go())


async def reset_llm_http_clients() -> None:
    """Dispose owned clients and clear in-flight maps (tests and timeout rebuilds)."""
    global _sync_client, _async_client, _client_timeout, _anthropic_clients, _anthropic_timeout
    anthropic_pair = _anthropic_clients
    _anthropic_clients = None
    _anthropic_timeout = None
    if anthropic_pair is not None:
        anthropic_pair[0]._dispose()
        await anthropic_pair[1]._dispose()
    with _lock:
        _in_flight_sync.clear()
        _in_flight_async.clear()
        _wrapped_response_ids.clear()
        sync = _sync_client
        async_c = _async_client
        _sync_client = None
        _async_client = None
        _client_timeout = None
    _dispose_sync_client(sync)
    await _dispose_async_client(async_c)


async def abort_in_flight_llm_requests(session_id: str) -> None:
    """Close in-flight generation response streams for ``session_id`` only.

    Empty / unknown ids are a no-op for HTTP close. Does not stop llama-server,
    unload the model, or dispose the httpx client. Closing the streamed Chat
    Completions body is what llama-server treats as cancel.
    """
    sid = (session_id or '').strip()
    if not sid:
        return
    with _lock:
        sync_resps = list(_in_flight_sync.pop(sid, set()))
        async_resps = list(_in_flight_async.pop(sid, set()))
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


async def abort_in_flight_generation(session: SessionState, session_id: str) -> None:
    """Signal the agent loop to stop and cancel that session's LLM generation request."""
    session.abort_event.set()
    pause = session.agent_pause_event
    if pause is not None:
        pause.set()
    await abort_in_flight_llm_requests(session_id)
