"""Regression: the SSE input multiplexer must not drop items when several queues are ready.

A HITL diff lands on ``hitl_q`` at the same moment the graph pump floods ``events_q``. If
``asyncio.wait(FIRST_COMPLETED)`` reports both ``get()`` tasks as done and only one is returned,
the other already dequeued its item and would lose it on cancellation — silently dropping the diff
card and leaving the agent paused forever.
"""

from __future__ import annotations

import asyncio

from nemo_backend.agent_langgraph import _race_stream_inputs


def test_race_does_not_drop_item_when_multiple_queues_ready() -> None:
    async def scenario() -> None:
        events_q: asyncio.Queue = asyncio.Queue()
        hitl_q: asyncio.Queue = asyncio.Queue()
        abort_event = asyncio.Event()

        # Both queues ready before the race so wait() can report both get() tasks done at once.
        events_q.put_nowait({'event': 'on_chat_model_stream'})
        hitl_q.put_nowait(('diff', {'version': 1, 'rows': []}))

        kind1, item1 = await _race_stream_inputs(
            events_q, hitl_q, labels=('ev', 'hitl'), abort_event=abort_event
        )
        # Earlier label wins; the hitl item must survive for the next round, not be lost.
        assert kind1 == 'ev'
        assert hitl_q.qsize() == 1

        kind2, item2 = await _race_stream_inputs(
            events_q, hitl_q, labels=('ev', 'hitl'), abort_event=abort_event
        )
        assert kind2 == 'hitl'
        assert item2 == ('diff', {'version': 1, 'rows': []})

    asyncio.run(scenario())


def test_race_returns_abort_when_signaled() -> None:
    async def scenario() -> None:
        events_q: asyncio.Queue = asyncio.Queue()
        hitl_q: asyncio.Queue = asyncio.Queue()
        abort_event = asyncio.Event()
        abort_event.set()

        kind, item = await _race_stream_inputs(
            events_q, hitl_q, labels=('ev', 'hitl'), abort_event=abort_event
        )
        assert kind == 'abort'
        assert item is None

    asyncio.run(scenario())
