"""Pure helpers to detect npm/TypeScript project layout (shared leaf, no lsp imports)."""

from __future__ import annotations

import json
import os
from pathlib import Path

__all__ = [
    'has_nonempty_node_modules',
    'has_typescript_tooling',
    'package_json_declares_typescript',
]


def has_typescript_tooling(project: Path) -> bool:
    """True if this directory looks like a TS project root (local typescript / tsc)."""
    nm = project / 'node_modules'
    if not nm.is_dir():
        return False
    if (nm / 'typescript').is_dir():
        return True
    if os.name == 'nt':
        if (nm / '.bin' / 'tsc.cmd').is_file():
            return True
        if (nm / '.bin' / 'tsc.ps1').is_file():
            return True
    return (nm / '.bin' / 'tsc').is_file()


def package_json_declares_typescript(project: Path) -> bool:
    """Fallback when node_modules is incomplete: read package.json for a typescript dev/dep."""
    pkg = project / 'package.json'
    if not pkg.is_file():
        return False
    try:
        data = json.loads(pkg.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    for key in ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
        block = data.get(key)
        if isinstance(block, dict) and 'typescript' in block:
            return True
    return False


def has_nonempty_node_modules(project: Path) -> bool:
    """True when ``project/node_modules`` exists and is non-empty."""
    nm = project / 'node_modules'
    if not nm.is_dir():
        return False
    try:
        return next(nm.iterdir(), None) is not None
    except OSError:
        return False
