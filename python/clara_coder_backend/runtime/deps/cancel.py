"""Cooperative cancellation for dependency installs.

An install runs inside :func:`installing`, which records the dependency id in a context
variable (copied into ``asyncio.to_thread`` workers). Long-running steps — byte downloads,
archive extraction, streamed subprocesses — call :func:`raise_if_cancelled` between units of
work, so a cancel request stops the install at the next safe point and the registry can clean
up whatever was left half-written.
"""

from __future__ import annotations

import contextvars
import threading
from collections.abc import Iterator
from contextlib import contextmanager


class InstallCancelled(Exception):
    """Raised inside an install when the user cancelled it."""

    def __init__(self, dep_id: str) -> None:
        super().__init__(f'{dep_id} install cancelled')
        self.dep_id = dep_id


_requested: set[str] = set()
_lock = threading.Lock()
_current: contextvars.ContextVar[str | None] = contextvars.ContextVar('clara_deps_installing', default=None)


def current() -> str | None:
    """Dependency id of the install running in this context, if any."""

    return _current.get()


def request_cancel(dep_id: str) -> None:
    with _lock:
        _requested.add(dep_id)


def _clear(dep_id: str) -> None:
    with _lock:
        _requested.discard(dep_id)


def is_cancelled(dep_id: str | None = None) -> bool:
    target = dep_id if dep_id is not None else _current.get()
    if target is None:
        return False
    with _lock:
        return target in _requested


def raise_if_cancelled(dep_id: str | None = None) -> None:
    target = dep_id if dep_id is not None else _current.get()
    if target is not None and is_cancelled(target):
        raise InstallCancelled(target)


@contextmanager
def installing(dep_id: str) -> Iterator[None]:
    """Mark ``dep_id`` as the install running in this context; stale requests are dropped."""

    _clear(dep_id)
    token = _current.set(dep_id)
    try:
        yield
    finally:
        _current.reset(token)
        _clear(dep_id)
