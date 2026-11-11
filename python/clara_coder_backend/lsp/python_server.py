"""Python language-server command resolution for the backend LSP manager."""

from __future__ import annotations

from clara_coder_backend.config import env_clara

import logging
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger('clara.lsp.manager')

__all__ = ['build_python_lsp_command']

_LANGSERVER_NAME = 'basedpyright-langserver'


def _with_stdio(command: list[str]) -> list[str]:
    if command and command[-1] != '--stdio':
        return [*command, '--stdio']
    return list(command)


def _adjacent_basedpyright_command(python_executable: Path) -> list[str] | None:
    bin_dir = python_executable.parent
    if sys.platform.startswith('win'):
        # Prefer the pip console-script .exe. ``.cmd`` / ``.bat`` need ``shell=True``
        # and hang or fail when spawned via ``Popen(list)``.
        exe = bin_dir / f'{_LANGSERVER_NAME}.exe'
        if exe.is_file():
            return _with_stdio([str(exe)])
        script_py = bin_dir / f'{_LANGSERVER_NAME}-script.py'
        if script_py.is_file():
            return _with_stdio([str(python_executable), '-u', str(script_py)])
    else:
        candidate = bin_dir / _LANGSERVER_NAME
        if candidate.is_file():
            return _with_stdio([str(candidate)])
    resolved = shutil.which(_LANGSERVER_NAME, path=str(bin_dir))
    if resolved:
        lowered = resolved.lower()
        if lowered.endswith(('.cmd', '.bat')):
            return None
        return _with_stdio([resolved])
    return None


def _python_module_fallback_command(python_executable: Path) -> list[str]:
    """Spawn basedpyright's langserver.

    ``python -m basedpyright.langserver`` does not call ``main()`` (no ``__main__``
    block). Console scripts invoke ``basedpyright.langserver:main``, which forwards
    remaining argv (including ``--stdio``) to the bundled Node runtime.
    """

    return [
        str(python_executable),
        '-u',
        '-c',
        'from basedpyright.langserver import main; main()',
        '--stdio',
    ]


def _can_import_basedpyright(python_executable: Path) -> bool:
    """True if this interpreter can import the ``basedpyright`` package."""

    cmd = [str(python_executable), '-c', 'import basedpyright']
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


def _resolve_basedpyright_command_for_interpreter(python_executable: Path) -> list[str] | None:
    """Return a spawn argv for basedpyright-langserver, or None if not installed."""

    adjacent = _adjacent_basedpyright_command(python_executable)
    if adjacent is not None:
        return adjacent
    if _can_import_basedpyright(python_executable):
        return _python_module_fallback_command(python_executable)
    return None


def build_python_lsp_command(workspace_root: Path) -> list[str]:
    """Return the command used to spawn the Python LSP server.

    The server **always** runs on the Clara backend interpreter so workspace folders
    can be removed without losing ``basedpyright``. Analysis environment (installed
    packages, types) comes from ``python.pythonPath`` / session Python paths, not
    from which interpreter launches the subprocess.

    ``CLARA_PYTHON_LSP_COMMAND`` may override argv entirely.
    """

    raw = env_clara('CLARA_PYTHON_LSP_COMMAND', '').strip()
    if raw:
        cmd = shlex.split(raw, posix=os.name != 'nt')
        logger.info('python LSP command override workspace=%s command=%s', workspace_root, cmd)
        return cmd

    backend_python = Path(sys.executable)
    cmd = _resolve_basedpyright_command_for_interpreter(backend_python)
    if cmd is not None:
        logger.info('python LSP command clara-backend workspace=%s command=%s', workspace_root, cmd)
        return cmd

    raise RuntimeError(
        'basedpyright is not installed on the Clara backend interpreter '
        f'({backend_python}). Reinstall Clara Coder, or run: '
        f'{backend_python} -m pip install "basedpyright>=1.29,<1.40"'
    )
