"""Resolve the Java project directory (Maven/Gradle markers under the session workspace)."""

from __future__ import annotations

from clara_coder_backend.session.config import env_clara

import logging
import os
from pathlib import Path

logger = logging.getLogger('clara.lsp.java_project_root')

__all__ = [
    'is_java_project_root',
    'resolve_java_project_root',
]

_SKIP_WALK_DIRS = frozenset(
    {
        'node_modules',
        '.git',
        'dist',
        'build',
        'target',
        'out',
        '.gradle',
        '.idea',
        '__pycache__',
        '.venv',
        'venv',
    }
)

_JAVA_ROOT_MARKERS = frozenset(
    {
        'pom.xml',
        'build.gradle',
        'build.gradle.kts',
        'settings.gradle',
        'settings.gradle.kts',
    }
)


def is_java_project_root(project: Path) -> bool:
    """True when ``project`` has a Maven or Gradle project marker file."""

    if not project.is_dir():
        return False
    for name in _JAVA_ROOT_MARKERS:
        if (project / name).is_file():
            return True
    return False


def _walk_up_from_seed(session_workspace: Path, relative_path: str) -> Path | None:
    """Walk parents from the file path until we find a Java project root under ``session_workspace``."""

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
        if is_java_project_root(cur):
            return cur
        if cur == session_workspace:
            break
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return None


def _discover_deepest_project(session_workspace: Path, *, max_depth: int = 16) -> Path | None:
    """Pick the deepest directory under session_workspace that looks like a Java project."""

    session_workspace = session_workspace.resolve()
    best: Path | None = None

    for dirpath, dirnames, filenames in os.walk(session_workspace):
        d = Path(dirpath)
        depth = 0 if d == session_workspace else len(d.relative_to(session_workspace).parts)
        if depth > max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = [x for x in dirnames if x not in _SKIP_WALK_DIRS]
        if not any(name in filenames for name in _JAVA_ROOT_MARKERS):
            continue
        if not is_java_project_root(d):
            continue
        if best is None or len(d.parts) > len(best.parts):
            best = d

    return best


def _env_override(session_workspace: Path) -> Path | None:
    raw = env_clara('CLARA_JAVA_LSP_PROJECT_ROOT', '').strip()
    if not raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        p = (session_workspace / raw).resolve()
    else:
        p = p.resolve()
    if p.is_dir() and is_java_project_root(p):
        logger.info('java project root from CLARA_JAVA_LSP_PROJECT_ROOT=%s', p)
        return p
    logger.warning('CLARA_JAVA_LSP_PROJECT_ROOT ignored (missing or not a Java project dir): %s', p)
    return None


def resolve_java_project_root(
    session_workspace_root: Path,
    *,
    seed_relative_path: str | None,
    allow_workspace_walk: bool = True,
) -> Path:
    """Return the directory to use as LSP cwd / ``rootUri`` for Eclipse JDT LS.

    Priority:

    1. ``CLARA_JAVA_LSP_PROJECT_ROOT`` (absolute or relative to the session workspace).
    2. Walk upward from ``seed_relative_path`` for a Maven/Gradle marker.
    3. Discover the **deepest** matching project under the workspace (limited depth).
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
                'java project root from seed path=%s root=%s',
                seed_relative_path,
                up,
            )
            return up

    if allow_workspace_walk:
        discovered = _discover_deepest_project(session_workspace_root)
        if discovered is not None:
            logger.info('java project root from discovery=%s', discovered)
            return discovered

    if is_java_project_root(session_workspace_root):
        logger.info('java project root is session workspace=%s', session_workspace_root)
        return session_workspace_root

    logger.warning(
        'java project root fallback to session workspace (no recognizable Maven/Gradle project): %s',
        session_workspace_root,
    )
    return session_workspace_root
