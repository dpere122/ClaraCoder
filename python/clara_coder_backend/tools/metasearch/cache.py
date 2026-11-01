"""Small TTL cache for built-in metasearch queries.

Scraping four engines per call is the expensive part of ``web_search``; agents often
re-ask the same query while narrowing a problem, so a short-lived cache pays for itself.
"""

from __future__ import annotations

import threading
import time
from typing import Any

__all__ = ['clear_cache', 'get_cached', 'put_cached']

_TTL_SEC = 300.0
_MAX_ENTRIES = 128

_lock = threading.Lock()
_entries: dict[tuple[Any, ...], tuple[float, Any]] = {}


def get_cached(key: tuple[Any, ...]) -> Any | None:
    """Return the cached value for ``key``, or ``None`` when missing or expired."""

    now = time.monotonic()
    with _lock:
        hit = _entries.get(key)
        if hit is None:
            return None
        expires_at, value = hit
        if expires_at <= now:
            _entries.pop(key, None)
            return None
        return value


def put_cached(key: tuple[Any, ...], value: Any) -> None:
    """Store ``value`` under ``key``, evicting expired then oldest entries when full."""

    now = time.monotonic()
    with _lock:
        if len(_entries) >= _MAX_ENTRIES:
            for stale in [k for k, (expires_at, _v) in _entries.items() if expires_at <= now]:
                _entries.pop(stale, None)
            while len(_entries) >= _MAX_ENTRIES:
                _entries.pop(next(iter(_entries)))
        _entries[key] = (now + _TTL_SEC, value)


def clear_cache() -> None:
    """Drop every cached query (tests, and Settings changes that alter the engine set)."""

    with _lock:
        _entries.clear()
