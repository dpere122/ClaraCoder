"""Spawn command for the TypeScript / JavaScript language server (vtsls).

Clara routes both TypeScript (``.ts`` / ``.tsx``) and JavaScript
(``.js`` / ``.jsx`` / ``.mjs`` / ``.cjs``) files through a single
`vtsls <https://github.com/yioneko/vtsls>`_ language server. vtsls wraps the
TypeScript language features bundled with VS Code and — unlike a pure
linter/formatter such as Biome — implements the full LSP navigation surface,
including ``textDocument/references`` (find all references), go-to-definition,
rename, hover, completion, and code actions for **both** JS and TS.

Resolution order (see :func:`resolve_typescript_lsp_spawn`):

1. ``CLARA_TYPESCRIPT_LSP_COMMAND`` — full argv override.
2. ``<workspace-or-ancestor>/node_modules/.bin/vtsls`` (when the user has Node
   and vtsls installed locally).
3. **The managed vtsls from Dependencies, run via the Electron binary in Node
   mode** — the ``vtsls`` dependency downloads ``@vtsls/language-server`` (which
   brings its own TypeScript) into ``<runtime>/vtsls/<version>/node_modules``,
   and Clara runs it with the Electron executable under
   ``ELECTRON_RUN_AS_NODE=1``. This is how VS Code runs its TypeScript server:
   no separate Node.js install is required.

Nothing is downloaded when the server starts: with none of the above, the
resolver returns None and the plugin asks the user to open Dependencies.

vtsls brings its own TypeScript, so plain JS workspaces (empty
``package.json``, no ``node_modules/typescript``) work without extra setup.
"""

from __future__ import annotations

from clara_coder_backend.config import env_clara

import logging
import os
import shlex
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger('clara.lsp.typescript_server')

__all__ = [
    'TypescriptLspSpawn',
    'resolve_typescript_lsp_spawn',
    'typescript_lsp_unavailable_message',
]

_VTLSLS_BIN_NAME = 'vtsls'


@dataclass(frozen=True)
class TypescriptLspSpawn:
    """Resolved argv + optional subprocess env for the vtsls language server."""

    command: list[str]
    env: dict[str, str] | None = None


def _local_vtsls_binary(bin_dir: Path) -> Path | None:
    if os.name == 'nt':
        for name in (f'{_VTLSLS_BIN_NAME}.cmd', f'{_VTLSLS_BIN_NAME}.exe', _VTLSLS_BIN_NAME):
            p = bin_dir / name
            if p.is_file():
                return p
    p = bin_dir / _VTLSLS_BIN_NAME
    return p if p.is_file() else None


def _find_workspace_vtsls(workspace_root: Path, *, max_hops: int = 24) -> Path | None:
    """Return path to vtsls in node_modules/.bin, walking up from workspace_root."""

    cur = Path(workspace_root).resolve()
    for _ in range(max_hops):
        found = _local_vtsls_binary(cur / 'node_modules' / '.bin')
        if found is not None:
            return found
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return None


def _electron_exec_path() -> Path | None:
    """The Electron executable the Electron main process passes to the backend, when it exists."""

    raw = env_clara('CLARA_ELECTRON_EXEC_PATH', '').strip()
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_file() else None


def _managed_vtsls_entry() -> Path | None:
    from clara_coder_backend.runtime.deps.providers import vtsls

    return vtsls.installed_binary()


def _managed_vtsls_spawn() -> TypescriptLspSpawn | None:
    """Run the vtsls installed from Dependencies via the Electron binary in Node mode.

    Returns None when vtsls is not installed (or is being replaced) or when the
    Electron executable (``CLARA_ELECTRON_EXEC_PATH``) is unknown.
    """

    entry = _managed_vtsls_entry()
    if entry is None:
        return None
    electron = _electron_exec_path()
    if electron is None:
        logger.warning('managed vtsls installed at %s but CLARA_ELECTRON_EXEC_PATH is not a file', entry)
        return None
    return TypescriptLspSpawn(
        command=[str(electron), str(entry), '--stdio'],
        # Force the Electron binary to behave as a plain Node.js runtime.
        env={'ELECTRON_RUN_AS_NODE': '1'},
    )


def resolve_typescript_lsp_spawn(workspace_root: Path) -> TypescriptLspSpawn | None:
    """Return argv (+ optional env) to run vtsls over stdio for ``workspace_root``, or None.

    None means no vtsls can run; :func:`typescript_lsp_unavailable_message` says why.
    """

    root = Path(workspace_root).resolve()
    raw = env_clara('CLARA_TYPESCRIPT_LSP_COMMAND', '').strip()
    if raw:
        cmd = shlex.split(raw, posix=os.name != 'nt')
        logger.info('typescript LSP command override workspace=%s command=%s', root, cmd)
        return TypescriptLspSpawn(cmd)

    local = _find_workspace_vtsls(root)
    if local is not None:
        cmd = [str(local), '--stdio']
        logger.info('typescript LSP command local bin workspace=%s command=%s', root, cmd)
        return TypescriptLspSpawn(cmd)

    managed = _managed_vtsls_spawn()
    if managed is not None:
        logger.info('typescript LSP command managed (electron-as-node) workspace=%s command=%s', root, managed.command)
        return managed

    logger.info('typescript LSP not available workspace=%s', root)
    return None


def typescript_lsp_unavailable_message() -> str:
    """What the user sees when :func:`resolve_typescript_lsp_spawn` finds no vtsls to run."""

    from clara_coder_backend.runtime.deps.providers import vtsls

    if _managed_vtsls_entry() is not None:
        raw = env_clara('CLARA_ELECTRON_EXEC_PATH', '').strip()
        where = f' ({raw} does not exist)' if raw else ' (CLARA_ELECTRON_EXEC_PATH is not set)'
        return (
            f'{vtsls.LABEL} is installed, but the Electron executable that runs it was not found{where}. '
            'Start the backend from Clara, or set CLARA_TYPESCRIPT_LSP_COMMAND.'
        )
    return f'{vtsls.LABEL} is not installed. Open Dependencies and download “{vtsls.LABEL}”, then retry.'
