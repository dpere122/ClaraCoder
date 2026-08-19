"""Control routes must stay responsive while a long-lived SSE stream is open.

Starlette ``BaseHTTPMiddleware`` can serialize HTTP behind an in-flight stream, which
blocked Electron ``POST /clear`` (New Conversation spinner) after llama-server start.
"""

from __future__ import annotations

import asyncio
import contextlib

import httpx


async def _health_and_clear_while_log_stream_open() -> None:
    from clara_coder_backend.main import app

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        stream_task = asyncio.create_task(client.get('/logs/stream', timeout=10.0))
        try:
            await asyncio.sleep(0.1)
            health = await asyncio.wait_for(client.get('/health'), timeout=2.0)
            assert health.status_code == 200
            cleared = await asyncio.wait_for(
                client.post('/clear', json={'session_id': 'concurrency-clear'}),
                timeout=2.0,
            )
            assert cleared.status_code == 200
            assert cleared.json().get('ok') is True
        finally:
            stream_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, httpx.HTTPError):
                await stream_task


def test_open_log_stream_does_not_block_health_or_clear() -> None:
    asyncio.run(_health_and_clear_while_log_stream_open())
