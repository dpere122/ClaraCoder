"""jedi-language-server ``initializationOptions`` for workspace-aware Jedi ``Project`` (hover/docs)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from clara_coder_backend.domain import SessionState
from clara_coder_backend.python_env import (
    resolve_python_workspace_root,
    workspace_python_executable,
)

__all__ = [
    'build_jedi_initialization_options',
    'deduce_venv_root_from_interpreter',
    'jedi_environment_path_for_workspace',
]


def deduce_venv_root_from_interpreter(python_executable: Path) -> Path | None:
    """If ``python_executable`` lives under a ``venv`` layout, return the venv root directory."""

    p = Path(python_executable).resolve()
    if not p.is_file():
        return None
    name_lower = p.name.lower()
    if not name_lower.startswith('python'):
        return None
    parent = p.parent
    if sys.platform.startswith('win'):
        if parent.name.lower() != 'scripts':
            return None
    else:
        if parent.name != 'bin':
            return None
    root = parent.parent.resolve()
    return root if root.is_dir() else None


def jedi_environment_path_for_workspace(session: SessionState, workspace_root: Path) -> str | None:
    """Return ``workspace.environmentPath`` for jedi-language-server (Jedi ``Project.environment_path``)."""

    raw = (session.python_workspace_venv_path or '').strip()
    if raw:
        vdir = Path(raw).expanduser()
        try:
            vdir = vdir.resolve()
        except OSError:
            return None
        if vdir.is_dir():
            return str(vdir)

    project_root, _ = resolve_python_workspace_root(workspace_root, allow_workspace_root_fallback=True)
    if project_root is None:
        return None
    exe = workspace_python_executable(project_root)
    if not exe.is_file():
        return None
    inferred = deduce_venv_root_from_interpreter(exe)
    if inferred is not None and inferred.is_dir():
        return str(inferred)
    return None


def build_jedi_initialization_options(session: SessionState, workspace_root: Path) -> dict[str, Any]:
    """Merge semantic tokens + workspace venv options for ``initialize``."""

    # jedi-language-server advertises ``completionItem/resolve``; without a resolve call, docs are
    # empty unless ``resolveEagerly`` is set. The Monaco editor only uses ``textDocument/completion``.
    opts: dict[str, Any] = {
        'semanticTokens': {'enable': True},
        'completion': {'resolveEagerly': True},
    }
    env_path = jedi_environment_path_for_workspace(session, workspace_root)
    if env_path:
        opts['workspace'] = {'environmentPath': env_path}
    return opts
