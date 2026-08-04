"""Workspace LSP framework for Clara (pluggable language servers).

Keep this package init lightweight so bootstrap tools (e.g. the deps CLI on a
bare portable Python) can import ``clara_coder_backend.lsp.java_server`` without
pulling LangChain / Jedi manager dependencies.
"""

from __future__ import annotations

from typing import Any

__all__ = ['get_session_lsp_manager', 'shutdown_session_lsp']


def __getattr__(name: str) -> Any:
    if name in ('get_session_lsp_manager', 'shutdown_session_lsp'):
        from clara_coder_backend.lsp.manager import get_session_lsp_manager, shutdown_session_lsp

        return get_session_lsp_manager if name == 'get_session_lsp_manager' else shutdown_session_lsp
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
