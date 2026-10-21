"""``GET /subagents/events``: the long-lived SSE stream of sub-agent activity (all conversations).

Electron keeps one connection open. The first line is ``data: {"type":"subscribed"}``, then one
``data: {json}`` line per bus event (see :mod:`clara_coder_backend.lang_agent.subagents`), with a
``: keepalive`` comment every :data:`KEEPALIVE_SEC` seconds. Events published while no client is
connected are buffered and sent first on the next connection.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from clara_coder_backend.lang_agent.subagent_bus import SUBAGENT_BUS

router = APIRouter(tags=['subagents'])

#: Seconds between keepalive comments while no event arrives.
KEEPALIVE_SEC = 15.0


class _BusSubscription:
    """One client's bus queue as an SSE line iterator; :meth:`close` unsubscribes (idempotent)."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue | None = None
        self._closed = False

    def __aiter__(self) -> AsyncIterator[str]:
        return self._lines()

    async def _lines(self) -> AsyncIterator[str]:
        # Subscribe on the first read, not in the route: a response that never starts must not hold a
        # queue that swallows events meant for the next connection.
        if self._closed:
            return
        self._queue = SUBAGENT_BUS.subscribe()
        try:
            yield f'data: {json.dumps({"type": "subscribed"})}\n\n'
            while True:
                try:
                    event = await asyncio.wait_for(self._queue.get(), timeout=KEEPALIVE_SEC)
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
                    continue
                yield f'data: {json.dumps(event)}\n\n'
        finally:
            self.close()

    def close(self) -> None:
        self._closed = True
        if self._queue is not None:
            SUBAGENT_BUS.unsubscribe(self._queue)


class _BusStreamingResponse(StreamingResponse):
    """Unsubscribes when the response ends however it ends (Starlette never closes the iterator)."""

    def __init__(self, subscription: _BusSubscription) -> None:
        super().__init__(subscription, media_type='text/event-stream')
        self._subscription = subscription

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._subscription.close()


@router.get('/subagents/events')
async def subagent_events() -> StreamingResponse:
    """SSE stream of every sub-agent event (started, wrapped payloads, finished, results ready)."""
    return _BusStreamingResponse(_BusSubscription())


__all__ = ['KEEPALIVE_SEC', 'router']
