"""Python language-server command resolution for the backend LSP manager."""

from __future__ import annotations

import logging
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

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
    """Spawn jedi-language-server via ``cli()`` — ``-m jedi_language_server.cli`` does **not** call it."""

    return [
        str(python_executable),
        '-u',
        '-c',
        'from jedi_language_server.cli import cli; cli()',
    ]


def _can_import_jedi_language_server(python_executable: Path) -> bool:
    """True if this interpreter can import the ``jedi_language_server`` package."""

    cmd = [str(python_executable), '-c', 'import jedi_language_server']
    try:
        if sys.platform == 'win32':
            flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            proc = subprocess.run(
                cmd,
                capture_output=True,
                timeout=30,
                check=False,
                creationflags=flags,
            )
        else:
            proc = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
        return proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _resolve_jedi_command_for_interpreter(python_executable: Path) -> list[str] | None:
    """Return a spawn argv for jedi-language-server, or None if not installed for this interpreter."""

    adjacent = _adjacent_jedi_language_server_command(python_executable)
    if adjacent is not None:
        return adjacent
    if _can_import_jedi_language_server(python_executable):
        return _python_module_fallback_command(python_executable)
    return None


def build_python_lsp_command(workspace_root: Path) -> list[str]:
    """Return the command used to spawn the Python LSP server.

    The server **always** runs on the Nemo backend interpreter so workspace folders can be
    removed without losing ``jedi-language-server``. Analysis environment (installed packages,
    docstrings) comes from ``initializationOptions.workspace.environmentPath`` / session
    Python paths, not from which interpreter launches the subprocess.

    ``NEMO_PYTHON_LSP_COMMAND`` may override argv entirely.
    """

    raw = os.environ.get('NEMO_PYTHON_LSP_COMMAND', '').strip()
    if raw:
        cmd = shlex.split(raw, posix=os.name != 'nt')
        logger.info('python LSP command override workspace=%s command=%s', workspace_root, cmd)
        return cmd

    backend_python = Path(sys.executable)
    cmd = _resolve_jedi_command_for_interpreter(backend_python)
    if cmd is not None:
        logger.info('python LSP command nemo-backend workspace=%s command=%s', workspace_root, cmd)
        return cmd

    logger.warning(
        'python LSP jedi-language-server missing on backend interpreter; blind module fallback workspace=%s',
        workspace_root,
    )
    return _python_module_fallback_command(backend_python)
