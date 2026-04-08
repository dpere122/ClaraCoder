"""Python language-server command resolution for the backend LSP manager."""

from __future__ import annotations

import logging
import os
import shlex
import shutil
import sys
from pathlib import Path

from nemo_backend.python_env import resolve_python_workspace_root, workspace_python_executable

logger = logging.getLogger('nemo.lsp.manager')

__all__ = ['build_python_lsp_command']


def _adjacent_jedi_language_server_command(python_executable: Path) -> list[str] | None:
    bin_dir = python_executable.parent
    if sys.platform.startswith('win'):
        for candidate_name in ('jedi-language-server.exe', 'jedi-language-server.cmd', 'jedi-language-server.bat'):
            candidate = bin_dir / candidate_name
            if candidate.is_file():
                return [str(candidate)]
        script_py = bin_dir / 'jedi-language-server-script.py'
        if script_py.is_file():
            return [str(python_executable), str(script_py)]
    else:
        candidate = bin_dir / 'jedi-language-server'
        if candidate.is_file():
            return [str(candidate)]
    resolved = shutil.which('jedi-language-server', path=str(bin_dir))
    if resolved:
        return [resolved]
    return None


def _python_module_fallback_command(python_executable: Path) -> list[str]:
    return [str(python_executable), '-m', 'jedi_language_server.cli']


def build_python_lsp_command(workspace_root: Path) -> list[str]:
    """Return the command used to spawn the Python LSP server.

    `NEMO_PYTHON_LSP_COMMAND` may override the default. When unset, Nemo uses the
    installed `jedi-language-server` console script from the selected interpreter's
    environment, falling back to `python -m jedi_language_server.cli` when needed.
    """

    raw = os.environ.get('NEMO_PYTHON_LSP_COMMAND', '').strip()
    if raw:
        cmd = shlex.split(raw, posix=os.name != 'nt')
        logger.info('python LSP command override workspace=%s command=%s', workspace_root, cmd)
        return cmd

    project_root, _project_root_label = resolve_python_workspace_root(workspace_root)
    python_executable = workspace_python_executable(project_root) if project_root is not None else None
    if python_executable is not None and python_executable.is_file():
        cmd = _adjacent_jedi_language_server_command(python_executable) or _python_module_fallback_command(
            python_executable
        )
        logger.info('python LSP command workspace-venv workspace=%s command=%s', workspace_root, cmd)
        return cmd

    default_python = Path(sys.executable)
    cmd = _adjacent_jedi_language_server_command(default_python) or _python_module_fallback_command(default_python)
    logger.info('python LSP command default workspace=%s command=%s', workspace_root, cmd)
    return cmd
