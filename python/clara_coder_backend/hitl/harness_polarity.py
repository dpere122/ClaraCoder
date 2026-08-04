"""ContextVar for harness crystal polarity (SSE signaling after tool results)."""

from __future__ import annotations

from contextvars import ContextVar
from typing import Literal

HarnessPolarity = Literal['positive', 'negative']

pending_harness_crystal_polarity: ContextVar[HarnessPolarity | None] = ContextVar(
    'pending_harness_crystal_polarity',
    default=None,
)

__all__ = ['HarnessPolarity', 'pending_harness_crystal_polarity']
