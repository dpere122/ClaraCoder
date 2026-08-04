"""Deferred context packs: registry, activation, and built-in PDF/WSDL/XML/JSON playbooks."""

from __future__ import annotations

# Register built-in packs on import (no llm.messages dependency).
from clara_coder_backend.context_packs import packs as _builtin_packs  # noqa: F401
from clara_coder_backend.context_packs.registry import (
    ContextPack,
    format_context_catalog,
    get_pack,
    list_packs,
    packs_for_tool,
    register_pack,
)
from clara_coder_backend.context_packs.tool import ACTIVATE_CONTEXT_NAME, ACTIVATE_CONTEXT_TOOLS, activate_context

__all__ = [
    'ACTIVATE_CONTEXT_NAME',
    'ACTIVATE_CONTEXT_TOOLS',
    'ContextPack',
    'activate_context',
    'activate_pack',
    'format_context_catalog',
    'get_pack',
    'list_packs',
    'maybe_activate_for_tool',
    'packs_for_tool',
    'register_pack',
    'relative_path_from_tool_args',
]


def __getattr__(name: str):
    """Lazy exports that pull in session/activation helpers."""
    if name in {'activate_pack', 'maybe_activate_for_tool', 'relative_path_from_tool_args'}:
        from clara_coder_backend.context_packs import activation as _activation

        return getattr(_activation, name)
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
