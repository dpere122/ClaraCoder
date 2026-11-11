"""Workspace trust: whether tools may run code that a workspace folder supplies.

The user decides per workspace, when adding it or later in Settings → Workspaces. Until
``/runtime-config`` has delivered the list, every workspace reads as untrusted.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path

from clara_coder_backend.session.state import runtime_config

__all__ = ['trusted_workspace_keys', 'workspace_is_trusted', 'workspace_trust_key']


def workspace_trust_key(path: str | Path) -> str:
    """Comparable form of a workspace folder: absolute, symlinks resolved, case-folded on Windows."""

    raw = str(path).strip()
    if not raw:
        return ''
    try:
        resolved = Path(raw).expanduser().resolve()
    except (OSError, RuntimeError):
        resolved = Path(os.path.abspath(raw))
    return os.path.normcase(str(resolved))


def trusted_workspace_keys(paths: Iterable[str]) -> frozenset[str]:
    return frozenset(key for key in (workspace_trust_key(path) for path in paths) if key)


def workspace_is_trusted(workspace_root: str | Path) -> bool:
    """True only for a folder the user marked trusted; subfolders and parents don't count."""

    key = workspace_trust_key(workspace_root)
    return bool(key) and key in runtime_config.trusted_workspace_keys
