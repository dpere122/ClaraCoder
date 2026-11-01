"""Per-engine cooldown after a blocker (rate limit, challenge page, 403).

A metasearch backend that keeps hammering an engine which just served a captcha
burns the user's IP for every other engine too. When an adapter reports a blocker
the engine is parked for a while, and the next search simply cycles past it.
"""

from __future__ import annotations

import threading
import time

__all__ = [
    'clear_cooldowns',
    'cooldown_remaining',
    'is_cooling',
    'mark_blocked',
    'snapshot',
]

_lock = threading.Lock()
_until: dict[str, float] = {}
_reason: dict[str, str] = {}


def mark_blocked(engine: str, *, seconds: float, reason: str = '') -> None:
    """Park ``engine`` for ``seconds`` (monotonic clock, so wall-clock jumps are harmless)."""

    now = time.monotonic()
    with _lock:
        _until[engine] = now + max(0.0, float(seconds))
        _reason[engine] = reason


def cooldown_remaining(engine: str) -> float:
    """Seconds left on ``engine``'s cooldown, or ``0.0`` when it may be used."""

    now = time.monotonic()
    with _lock:
        until = _until.get(engine)
        if until is None:
            return 0.0
        remaining = until - now
        if remaining <= 0.0:
            _until.pop(engine, None)
            _reason.pop(engine, None)
            return 0.0
        return remaining


def is_cooling(engine: str) -> bool:
    return cooldown_remaining(engine) > 0.0


def snapshot() -> dict[str, float]:
    """Engine -> remaining seconds for every engine still cooling down."""

    now = time.monotonic()
    with _lock:
        out: dict[str, float] = {}
        for name, until in list(_until.items()):
            remaining = until - now
            if remaining <= 0.0:
                _until.pop(name, None)
                _reason.pop(name, None)
            else:
                out[name] = remaining
        return out


def clear_cooldowns() -> None:
    """Drop every cooldown (tests, and Settings changes that alter the engine set)."""

    with _lock:
        _until.clear()
        _reason.clear()
