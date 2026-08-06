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
3. **Bundled vtsls run via the Electron binary in Node mode** — Clara ships
   ``@vtsls/language-server`` (which bundles its own ``tsserver``) inside the
   app and runs it with the Electron executable under
   ``ELECTRON_RUN_AS_NODE=1``. This is how VS Code runs its TypeScript server:
   no separate Node.js install and no on-demand download are required.
4. ``npx -y -p @vtsls/language-server -- vtsls --stdio`` fallback (needs system
   Node; downloads on first use).

vtsls bundles its own TypeScript, so plain JS workspaces (empty
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

__all__ = ['TypescriptLspSpawn', 'build_typescript_lsp_command', 'resolve_typescript_lsp_spawn']

_VTLSLS_NPM_PACKAGE = '@vtsls/language-server'
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


def _bundled_vtsls_spawn() -> TypescriptLspSpawn | None:
    """Run the in-app bundled vtsls via the Electron binary in Node mode.

    Requires both ``CLARA_ELECTRON_EXEC_PATH`` (the Electron executable, passed
    from the Electron main process to the Python sidecar) and
    ``CLARA_VTSLS_BUNDLED_ENTRY`` (the bundled ``vtsls.js`` entry path) to be
    set and point at existing files. Returns ``None`` when the bundle is absent
    (e.g. dev without ``npm run bundle:vtsls``) so the caller falls back to npx.
    """

    electron = env_clara('CLARA_ELECTRON_EXEC_PATH', '').strip()
    entry = env_clara('CLARA_VTSLS_BUNDLED_ENTRY', '').strip()
    if not electron or not entry:
        return None
    if not Path(electron).is_file() or not Path(entry).is_file():
        logger.warning(
            'bundled vtsls env set but path missing electron=%s entry=%s; falling back',
            electron,
            entry,
        )
        return None
    return TypescriptLspSpawn(
        command=[electron, entry, '--stdio'],
        # Force the Electron binary to behave as a plain Node.js runtime.
        env={'ELECTRON_RUN_AS_NODE': '1'},
    )


def resolve_typescript_lsp_spawn(workspace_root: Path) -> TypescriptLspSpawn:
    """Return argv (+ optional env) to run vtsls over stdio for ``workspace_root``."""

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

    bundled = _bundled_vtsls_spawn()
    if bundled is not None:
        logger.info('typescript LSP command bundled (electron-as-node) workspace=%s command=%s', root, bundled.command)
        return bundled

    npx = 'npx.cmd' if os.name == 'nt' else 'npx'
    cmd = [npx, '-y', '-p', _VTLSLS_NPM_PACKAGE, '--', _VTLSLS_BIN_NAME, '--stdio']
    logger.info('typescript LSP command npx fallback workspace=%s command=%s', root, cmd)
    return TypescriptLspSpawn(cmd)


def build_typescript_lsp_command(workspace_root: Path) -> list[str]:
    """Return just the argv for vtsls (back-compat helper; see :func:`resolve_typescript_lsp_spawn`)."""

    return list(resolve_typescript_lsp_spawn(workspace_root).command)
