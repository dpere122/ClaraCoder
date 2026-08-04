"""Managed runtime dependency downloads (Python venv, llama-server, JDT LS, Kokoro).

Keep this package init empty so ``python -m clara_coder_backend.runtime.deps`` can
load ``__main__`` without eagerly importing every provider.
"""

from __future__ import annotations

__all__ = [
    'DEPENDENCY_IDS',
    'delete_dependency',
    'get_dependency',
    'install_dependency',
    'list_dependencies',
    'reinstall_dependency',
]


def __getattr__(name: str):
    if name in __all__:
        from clara_coder_backend.runtime.deps import registry

        return getattr(registry, name)
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
