"""Spawn command for the TypeScript/JavaScript language server (typescript-language-server)."""

from __future__ import annotations

import logging
import os
import shlex
from pathlib import Path

from nemo_backend.lsp.typescript_project_root import workspace_has_typescript_tooling

logger = logging.getLogger('nemo.lsp.typescript_server')

__all__ = ['build_typescript_lsp_command']


def _local_typescript_ls_binary(bin_dir: Path) -> Path | None:
    if os.name == 'nt':
        for name in ('typescript-language-server.cmd', 'typescript-language-server.exe'):
            p = bin_dir / name
            if p.is_file():
                return p
    p = bin_dir / 'typescript-language-server'
    return p if p.is_file() else None


def _find_workspace_typescript_ls(workspace_root: Path, *, max_hops: int = 24) -> Path | None:
    """Return path to typescript-language-server in node_modules/.bin, walking up from workspace_root."""
    cur = Path(workspace_root).resolve()
    for _ in range(max_hops):
        bin_dir = cur / 'node_modules' / '.bin'
        found = _local_typescript_ls_binary(bin_dir)
        if found is not None:
            return found
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return None


def build_typescript_lsp_command(workspace_root: Path) -> list[str]:
    """Return argv to run typescript-language-server over stdio.

    ``NEMO_TYPESCRIPT_LSP_COMMAND`` may override the default. When unset, Nemo prefers
    ``<workspace-or-ancestor>/node_modules/.bin/typescript-language-server`` (``.cmd`` on Windows)
    when that package root also has local ``typescript``/``tsc``, then falls back to
    ``npx`` / ``npx.cmd`` with ``-y -p typescript -p typescript-language-server`` so tsserver is present
    even for plain JS trees without ``node_modules/typescript``.
    """

    root = Path(workspace_root).resolve()
    raw = os.environ.get('NEMO_TYPESCRIPT_LSP_COMMAND', '').strip()
    if raw:
        cmd = shlex.split(raw, posix=os.name != 'nt')
        logger.info('typescript LSP command override workspace=%s command=%s', root, cmd)
        return cmd

    local = _find_workspace_typescript_ls(root)
    if local is not None:
        # ``.../node_modules/.bin/<script>`` → package root that owns ``node_modules``
        project_for_nm = local.parent.parent.parent
        if workspace_has_typescript_tooling(project_for_nm):
            cmd = [str(local), '--stdio']
            logger.info('typescript LSP command local bin workspace=%s command=%s', root, cmd)
            return cmd
        logger.info(
            'typescript LSP local bin ignored (no typescript/tsserver in that node_modules); '
            'using npx workspace=%s local=%s',
            root,
            local,
        )

    npx = 'npx.cmd' if os.name == 'nt' else 'npx'
    # typescript-language-server requires the ``typescript`` package for tsserver; ``npx -y`` only
    # fetched the server before, which breaks plain JS workspaces with no ``node_modules/typescript``.
    cmd = [
        npx,
        '-y',
        '-p',
        'typescript',
        '-p',
        'typescript-language-server',
        '--',
        'typescript-language-server',
        '--stdio',
    ]
    logger.info('typescript LSP command npx fallback workspace=%s command=%s', root, cmd)
    return cmd
