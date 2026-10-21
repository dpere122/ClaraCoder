"""Process-wide event bus for sub-agent activity, served by ``GET /subagents/events``.

Sub-agents outlive the turn that started them, so their events cannot ride the parent's
``/chat/stream``. Every event goes on this bus instead (``subagent_started``, ``subagent_event``,
``subagent_finished``, ``subagent_results_ready``; see :mod:`~clara_coder_backend.lang_agent.subagents`).

- Each connected subscriber gets every event, in publish order.
- While nobody is subscribed (Electron reconnecting after a sidecar hiccup), events are buffered, up to
  :data:`BUS_BUFFER_MAX`, and handed to the next subscriber first. A full buffer drops the oldest
  streaming detail (token chunks, statuses) before anything that matters later (start / finish
  markers, results-ready, journal rows, approval cards, final text).
- A subscriber that leaves with events still queued hands them back to the buffer when it was the last
  one, so a dropped connection loses at most the event that was being written.

Publishing is synchronous and happens on the event loop.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any

logger = logging.getLogger('clara.agent.subagent_bus')

#: Events kept for the next subscriber while none is connected.
BUS_BUFFER_MAX = 5_000

#: Wrapped payload types a full buffer never drops while it can drop something else: journal rows
#: (needed to review and reset a sub-agent's edits), approval cards and the sub-agent's final text.
_KEEP_PAYLOAD_TYPES = frozenset({'file_journal', 'accept_command', 'delete_confirm', 'final_text'})


def _droppable(event: dict[str, Any]) -> bool:
    if event.get('type') != 'subagent_event':
        return False
    payload = event.get('payload')
    return not (isinstance(payload, dict) and payload.get('type') in _KEEP_PAYLOAD_TYPES)


class SubagentEventBus:
    """Fan-out of sub-agent event dicts with buffering while no subscriber is connected."""

    def __init__(self, buffer_max: int = BUS_BUFFER_MAX) -> None:
        self._subscribers: list[asyncio.Queue] = []
        self._buffer: deque[dict[str, Any]] = deque()
        self._buffer_max = max(1, int(buffer_max))
        self._dropped = 0

    def _drop_one(self) -> None:
        """Drop the oldest streaming detail (a token chunk, a status), else the oldest event."""
        for index, buffered in enumerate(self._buffer):
            if _droppable(buffered):
                del self._buffer[index]
                return
        self._buffer.popleft()

    def _buffer_event(self, event: dict[str, Any]) -> None:
        if len(self._buffer) >= self._buffer_max:
            self._drop_one()
            self._dropped += 1
            if self._dropped == 1 or self._dropped % 1000 == 0:
                logger.warning('Sub-agent event buffer full (%d); dropped %d oldest event(s)', self._buffer_max, self._dropped)
        self._buffer.append(event)

    def publish(self, event: dict[str, Any]) -> None:
        """Deliver ``event`` to every subscriber, or buffer it when there is none."""
        if not self._subscribers:
            self._buffer_event(event)
            return
        for queue in list(self._subscribers):
            queue.put_nowait(event)

    def subscribe(self) -> asyncio.Queue:
        """A new subscriber queue, pre-filled with the buffered events (the buffer empties)."""
        queue: asyncio.Queue = asyncio.Queue()
        while self._buffer:
            queue.put_nowait(self._buffer.popleft())
        self._dropped = 0
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        """Remove a subscriber (idempotent). The last one hands its unread events back to the buffer."""
        try:
            self._subscribers.remove(queue)
        except ValueError:
            return
        if self._subscribers:
            return
        unread: list[dict[str, Any]] = []
        while True:
            try:
                unread.append(queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        # Unread events are older than anything buffered since; they go first.
        newer = list(self._buffer)
        self._buffer.clear()
        for event in [*unread, *newer]:
            self._buffer_event(event)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def buffered(self) -> list[dict[str, Any]]:
        """Copy of the events waiting for a subscriber (tests, diagnostics)."""
        return list(self._buffer)

    def reset(self) -> None:
        """Forget subscribers and buffered events (tests)."""
        self._subscribers.clear()
        self._buffer.clear()
        self._dropped = 0


#: The process-wide bus.
SUBAGENT_BUS = SubagentEventBus()


__all__ = ['BUS_BUFFER_MAX', 'SUBAGENT_BUS', 'SubagentEventBus']
