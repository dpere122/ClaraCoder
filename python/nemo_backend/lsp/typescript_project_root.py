"""Resolve the Node/TypeScript project directory (nested package.json under the session workspace)."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger('nemo.lsp.typescript_project_root')

__all__ = [
    'package_node_modules_link_rels',
    'resolve_typescript_project_root',
    'workspace_has_typescript_tooling',
]

_SKIP_WALK_DIRS = frozenset(
    {
        'node_modules',
        '.git',
        'dist',
        'build',
        '.angular',
        'coverage',
        '__pycache__',
        '.venv',
        'venv',
    }
)


def _has_typescript_tooling(project: Path) -> bool:
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


def workspace_has_typescript_tooling(project: Path) -> bool:
    """Public helper: whether ``project`` has a local ``typescript`` / ``tsc`` install (tsserver dependency)."""

    return _has_typescript_tooling(project)


def _package_json_declares_typescript(project: Path) -> bool:
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


def _has_nonempty_node_modules(project: Path) -> bool:
    """True when ``project/node_modules`` exists and is non-empty (npm/yarn install has been run)."""

    nm = project / 'node_modules'
    if not nm.is_dir():
        return False
    try:
        return next(nm.iterdir(), None) is not None
    except OSError:
        return False


def _is_node_project_root(project: Path) -> bool:
    if not (project / 'package.json').is_file():
        return False
    return (
        _has_typescript_tooling(project)
        or _package_json_declares_typescript(project)
        or _has_nonempty_node_modules(project)
    )


def package_node_modules_link_rels(session_workspace: Path, *, max_depth: int = 16) -> tuple[str, ...]:
    """``package.json`` directories that have ``node_modules``, as relative POSIX paths to that ``node_modules``.

    Used to symlink real dependency trees into staging workspace mirrors (mirrors skip ``node_modules`` copies).
    """

    session_workspace = Path(session_workspace).resolve()
    seen: set[str] = set()
    ordered: list[str] = []

    for dirpath, dirnames, filenames in os.walk(session_workspace):
        d = Path(dirpath)
        depth = 0 if d == session_workspace else len(d.relative_to(session_workspace).parts)
        if depth > max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = [x for x in dirnames if x not in _SKIP_WALK_DIRS]
        if 'package.json' not in filenames:
            continue
        nm = d / 'node_modules'
        if not nm.is_dir():
            continue
        rel = nm.relative_to(session_workspace).as_posix()
        if rel in seen:
            continue
        seen.add(rel)
        ordered.append(rel)

    return tuple(sorted(ordered, key=len))


def _walk_up_from_seed(session_workspace: Path, relative_path: str) -> Path | None:
    """Walk parents from the file path until we find a Node package root under ``session_workspace``."""

    session_workspace = session_workspace.resolve()
    rel = relative_path.strip().replace('\\', '/')
    if not rel or rel == '.':
        return None
    target = (session_workspace / rel).resolve()
    try:
        target.relative_to(session_workspace)
    except ValueError:
        return None
    cur: Path = target if target.is_dir() else target.parent
    for _ in range(128):
        try:
            cur.relative_to(session_workspace)
        except ValueError:
            break
        if _is_node_project_root(cur):
            return cur
        if cur == session_workspace:
            break
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return None


def _discover_deepest_project(session_workspace: Path, *, max_depth: int = 16) -> Path | None:
    """Pick the deepest directory under session_workspace that looks like a Node / TS package."""

    session_workspace = session_workspace.resolve()
    best: Path | None = None

    for dirpath, dirnames, filenames in os.walk(session_workspace):
        d = Path(dirpath)
        depth = 0 if d == session_workspace else len(d.relative_to(session_workspace).parts)
        if depth > max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = [x for x in dirnames if x not in _SKIP_WALK_DIRS]
        if 'package.json' not in filenames:
            continue
        if not _is_node_project_root(d):
            continue
        if best is None or len(d.parts) > len(best.parts):
            best = d

    return best


def _env_override(session_workspace: Path) -> Path | None:
    raw = os.environ.get('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT', '').strip()
    if not raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        p = (session_workspace / raw).resolve()
    else:
        p = p.resolve()
    if p.is_dir() and (p / 'package.json').is_file():
        logger.info('typescript project root from NEMO_TYPESCRIPT_LSP_PROJECT_ROOT=%s', p)
        return p
    logger.warning('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT ignored (missing or not a package dir): %s', p)
    return None


def resolve_typescript_project_root(
    session_workspace_root: Path,
    *,
    seed_relative_path: str | None,
) -> Path:
    """Return the directory to use as LSP cwd and ``rootUri`` for typescript-language-server.

    Priority:

    1. ``NEMO_TYPESCRIPT_LSP_PROJECT_ROOT`` (absolute path or path relative to the session workspace).
    2. Walk upward from ``seed_relative_path`` (first opened/synced file) for a Node package root.
    3. Discover the **deepest** matching project under the workspace (limited depth, skips ``node_modules`` dirs).
    4. Fall back to ``session_workspace_root``.
    """

    session_workspace_root = Path(session_workspace_root).resolve()

    override = _env_override(session_workspace_root)
    if override is not None:
        return override

    if seed_relative_path:
        up = _walk_up_from_seed(session_workspace_root, seed_relative_path)
        if up is not None:
            logger.info(
                'typescript project root from seed path=%s root=%s',
                seed_relative_path,
                up,
            )
            return up

    discovered = _discover_deepest_project(session_workspace_root)
    if discovered is not None:
        logger.info('typescript project root from discovery=%s', discovered)
        return discovered

    if _is_node_project_root(session_workspace_root):
        logger.info('typescript project root is session workspace=%s', session_workspace_root)
        return session_workspace_root

    logger.warning(
        'typescript project root fallback to session workspace (no recognizable Node package): %s',
        session_workspace_root,
    )
    return session_workspace_root
