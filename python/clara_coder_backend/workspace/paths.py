"""Shared path and text truncation helpers (no tools/staging/lsp imports)."""

from __future__ import annotations

from pathlib import Path

__all__ = [
    'normalize_relative_path',
    'truncate_text',
    'truncate_text_head_tail',
]


def normalize_relative_path(root: Path, relative_path: str) -> Path:
    """Resolve a user/tool-relative path under root; raise if it escapes the workspace."""
    cleaned = relative_path.strip().replace('\\', '/') or '.'
    candidate = (root / cleaned).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError('Requested path is outside the active workspace.') from exc
    return candidate


def truncate_text(value: str, limit: int) -> str:
    """Truncate long strings with an explicit marker (used in SSE status lines)."""
    if len(value) <= limit:
        return value
    return f'{value[:limit]}\n... [truncated]'


def truncate_text_head_tail(value: str, limit: int, *, marker: str = '\n... [truncated middle] ...\n') -> str:
    """Truncate by keeping a head and tail slice so failure lines near the end stay visible."""
    if len(value) <= limit:
        return value
    marker_len = len(marker)
    if limit <= marker_len + 16:
        return truncate_text(value, limit)
    budget = limit - marker_len
    # Bias toward the tail (typical logs: banner at start, errors at end).
    head_n = max(1, budget * 12 // 100)
    tail_n = budget - head_n
    return f'{value[:head_n]}{marker}{value[-tail_n:]}'
