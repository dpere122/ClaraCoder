"""Registration hooks for LSP staging overlay (breaks lsp → staging import cycle)."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from clara_coder_backend.domain import SessionState

_EnsureFn = Callable[..., Path]
_ClearFn = Callable[[SessionState], None]

_ensure_lsp_staging_overlay: _EnsureFn | None = None
_clear_lsp_staging_overlay: _ClearFn | None = None

__all__ = [
    'register_lsp_staging_overlay_hooks',
    'ensure_lsp_staging_overlay',
    'clear_lsp_staging_overlay',
]


def register_lsp_staging_overlay_hooks(*, ensure: _EnsureFn, clear: _ClearFn) -> None:
    global _ensure_lsp_staging_overlay, _clear_lsp_staging_overlay
    _ensure_lsp_staging_overlay = ensure
    _clear_lsp_staging_overlay = clear


def ensure_lsp_staging_overlay(
    session: SessionState,
    workspace_root: Path,
    *,
    session_id: str | None = None,
) -> Path:
    if _ensure_lsp_staging_overlay is None:
        raise RuntimeError('LSP staging overlay hooks are not registered.')
    return _ensure_lsp_staging_overlay(session, workspace_root, session_id=session_id)


def clear_lsp_staging_overlay(session: SessionState) -> None:
    if _clear_lsp_staging_overlay is None:
        return
    _clear_lsp_staging_overlay(session)
