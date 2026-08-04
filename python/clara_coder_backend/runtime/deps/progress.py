"""In-process progress callbacks for dependency install operations."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


ProgressCallback = Callable[[dict[str, Any]], None]


@dataclass
class ProgressBus:
    """Thread-safe-ish fan-out of progress dicts (single-threaded FastAPI worker is fine)."""

    _listeners: list[ProgressCallback] = field(default_factory=list)
    _last: dict[str, dict[str, Any]] = field(default_factory=dict)

    def subscribe(self, cb: ProgressCallback) -> None:
        self._listeners.append(cb)

    def unsubscribe(self, cb: ProgressCallback) -> None:
        try:
            self._listeners.remove(cb)
        except ValueError:
            pass

    def emit(
        self,
        dep_id: str,
        phase: str,
        *,
        bytes_done: int | None = None,
        bytes_total: int | None = None,
        message: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            'depId': dep_id,
            'phase': phase,
        }
        if bytes_done is not None:
            payload['bytesDone'] = bytes_done
        if bytes_total is not None:
            payload['bytesTotal'] = bytes_total
        if message is not None:
            payload['message'] = message
        self._last[dep_id] = payload
        for cb in list(self._listeners):
            try:
                cb(payload)
            except Exception:
                pass

    def last(self, dep_id: str) -> dict[str, Any] | None:
        return self._last.get(dep_id)


PROGRESS = ProgressBus()
