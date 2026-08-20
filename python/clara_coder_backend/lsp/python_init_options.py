"""basedpyright ``initializationOptions`` (pythonPath + analysis defaults)."""

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
    'build_python_initialization_options',
    'deduce_venv_root_from_interpreter',
    'python_environment_path_for_workspace',
    'python_interpreter_path_for_workspace',
]


def python_environment_path_for_workspace(session: SessionState, workspace_root: Path) -> str | None:
    """Return the workspace venv root for dashboard / LSP metadata."""

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


def python_interpreter_path_for_workspace(session: SessionState, workspace_root: Path) -> str | None:
    """Return the workspace Python executable for ``python.pythonPath``."""

    raw = (session.python_workspace_python_executable or '').strip()
    if raw:
        exe = Path(raw).expanduser()
        try:
            exe = exe.resolve()
        except OSError:
            exe = Path(raw)
        if exe.is_file():
            return str(exe)

    project_root, _ = resolve_python_workspace_root(workspace_root, allow_workspace_root_fallback=True)
    if project_root is None:
        return None
    exe = workspace_python_executable(project_root)
    if exe.is_file():
        try:
            return str(exe.resolve())
        except OSError:
            return str(exe)
    return None


def build_python_initialization_options(session: SessionState, workspace_root: Path) -> dict[str, Any]:
    """basedpyright settings for ``initialize`` / ``workspace/configuration``."""

    opts: dict[str, Any] = {
        'basedpyright': {
            'analysis': {
                'diagnosticMode': 'openFilesOnly',
                'typeCheckingMode': 'standard',
                'autoSearchPaths': True,
                'useLibraryCodeForTypes': True,
            }
        }
    }
    python_path = python_interpreter_path_for_workspace(session, workspace_root)
    if python_path:
        opts['python'] = {'pythonPath': python_path}
    return opts
