"""jedi-language-server ``initializationOptions`` for workspace-aware Jedi ``Project`` (hover/docs)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from clara_coder_backend.domain import SessionState
from clara_coder_backend.runtime.python_env import (
    deduce_venv_root_from_interpreter,
    resolve_python_workspace_root,
    workspace_python_executable,
)

__all__ = [
    'build_jedi_initialization_options',
    'deduce_venv_root_from_interpreter',
    'jedi_environment_path_for_workspace',
]


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
