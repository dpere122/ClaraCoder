"""Resolve the Java project directory and who owns its classpath.

A Java file belongs to the nearest ancestor folder (within the session workspace) that
has an owner marker:

* ``pom.xml`` → Maven, ``build.gradle(.kts)`` / ``settings.gradle(.kts)`` → Gradle. The
  build tool owns the classpath; Clara sends no ``java.project.*`` path settings.
* ``.project`` + ``.classpath`` → a hand-written Eclipse project; JDT LS reads it as is.
* ``.clara/java.json`` → a loose folder the user configured explicitly.

With no marker up to the workspace root the file is in a **loose** folder: JDT LS builds
an "invisible project" for the workspace and Clara supplies inferred source folders.
"""

from __future__ import annotations

from clara_coder_backend.config import env_clara
from clara_coder_backend.workspace.meta import WORKSPACE_META_DIR

import logging
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger('clara.lsp.java_project_root')

__all__ = [
    'JAVA_LAYOUT_ECLIPSE',
    'JAVA_LAYOUT_GRADLE',
    'JAVA_LAYOUT_LOOSE',
    'JAVA_LAYOUT_MAVEN',
    'JAVA_LOOSE_CONFIG_NAME',
    'JavaProjectLayout',
    'classify_java_project_dir',
    'detect_java_project_layout',
    'is_java_project_root',
    'java_layout_for_dir',
    'resolve_java_project_root',
]

JAVA_LAYOUT_MAVEN = 'maven'
JAVA_LAYOUT_GRADLE = 'gradle'
JAVA_LAYOUT_ECLIPSE = 'eclipse'
JAVA_LAYOUT_LOOSE = 'loose'

#: Per-folder loose-project config, relative to the folder it configures.
JAVA_LOOSE_CONFIG_NAME = 'java.json'

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

_MAVEN_MARKERS = ('pom.xml',)
_GRADLE_BUILD_MARKERS = ('build.gradle', 'build.gradle.kts')
_GRADLE_SETTINGS_MARKERS = ('settings.gradle', 'settings.gradle.kts')

_JAVA_ROOT_MARKERS = frozenset(
    {
        *_MAVEN_MARKERS,
        *_GRADLE_BUILD_MARKERS,
        *_GRADLE_SETTINGS_MARKERS,
    }
)


@dataclass(frozen=True)
class JavaProjectLayout:
    """Where JDT LS should start and who owns the classpath there."""

    kind: str
    root: Path
    #: ``.clara/java.json`` for a configured loose folder; None otherwise.
    config_path: Path | None = None

    @property
    def is_loose(self) -> bool:
        return self.kind == JAVA_LAYOUT_LOOSE


def _has_any_file(folder: Path, names: tuple[str, ...]) -> bool:
    return any((folder / name).is_file() for name in names)


def _loose_config_path(folder: Path) -> Path:
    return folder / WORKSPACE_META_DIR / JAVA_LOOSE_CONFIG_NAME


def classify_java_project_dir(folder: Path) -> str | None:
    """Return the layout kind owned by markers directly in ``folder``, or None.

    Build files win over Eclipse metadata in the same folder (Buildship/m2e write
    ``.project``/``.classpath`` next to them), and both win over ``.clara/java.json``.
    """

    if not folder.is_dir():
        return None
    if _has_any_file(folder, _MAVEN_MARKERS):
        return JAVA_LAYOUT_MAVEN
    if _has_any_file(folder, _GRADLE_BUILD_MARKERS) or _has_any_file(folder, _GRADLE_SETTINGS_MARKERS):
        return JAVA_LAYOUT_GRADLE
    if (folder / '.project').is_file() and (folder / '.classpath').is_file():
        return JAVA_LAYOUT_ECLIPSE
    if _loose_config_path(folder).is_file():
        return JAVA_LAYOUT_LOOSE
    return None


def _layout_for_dir(folder: Path, kind: str) -> JavaProjectLayout:
    config = _loose_config_path(folder) if kind == JAVA_LAYOUT_LOOSE else None
    return JavaProjectLayout(kind=kind, root=folder, config_path=config)


def java_layout_for_dir(folder: Path) -> JavaProjectLayout | None:
    """Layout for a previously resolved project folder, or None when it has no marker."""

    kind = classify_java_project_dir(folder)
    return _layout_for_dir(folder, kind) if kind is not None else None


def is_java_project_root(project: Path) -> bool:
    """True when ``project`` has a Maven or Gradle project marker file."""

    if not project.is_dir():
        return False
    for name in _JAVA_ROOT_MARKERS:
        if (project / name).is_file():
            return True
    return False


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _gradle_settings_root(build_dir: Path, session_workspace: Path) -> Path:
    """Lift a Gradle subproject to the nearest ancestor holding ``settings.gradle(.kts)``.

    JDT LS must import a multi-project build from its settings folder; starting it in a
    subproject leaves sibling projects (and their classpath entries) unresolved.
    """

    if _has_any_file(build_dir, _GRADLE_SETTINGS_MARKERS):
        return build_dir
    cur = build_dir.parent
    while _is_within(cur, session_workspace):
        if _has_any_file(cur, _GRADLE_SETTINGS_MARKERS):
            return cur
        if cur == session_workspace or cur.parent == cur:
            break
        cur = cur.parent
    return build_dir


def _seed_start_dir(session_workspace: Path, relative_path: str) -> Path | None:
    rel = relative_path.strip().replace('\\', '/')
    if not rel or rel == '.':
        return None
    target = (session_workspace / rel).resolve()
    if not _is_within(target, session_workspace):
        return None
    return target if target.is_dir() else target.parent


def _walk_up_for_layout(session_workspace: Path, relative_path: str) -> JavaProjectLayout | None:
    """Nearest owner marker on the path from ``relative_path`` up to ``session_workspace``."""

    cur = _seed_start_dir(session_workspace, relative_path)
    if cur is None:
        return None
    for _ in range(128):
        if not _is_within(cur, session_workspace):
            break
        kind = classify_java_project_dir(cur)
        if kind == JAVA_LAYOUT_GRADLE:
            return JavaProjectLayout(kind=kind, root=_gradle_settings_root(cur, session_workspace))
        if kind is not None:
            return _layout_for_dir(cur, kind)
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


def _env_override(session_workspace: Path) -> JavaProjectLayout | None:
    raw = env_clara('CLARA_JAVA_LSP_PROJECT_ROOT', '').strip()
    if not raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        p = (session_workspace / raw).resolve()
    else:
        p = p.resolve()
    kind = classify_java_project_dir(p)
    if kind is not None:
        logger.info('java project root from CLARA_JAVA_LSP_PROJECT_ROOT=%s kind=%s', p, kind)
        return _layout_for_dir(p, kind)
    logger.warning('CLARA_JAVA_LSP_PROJECT_ROOT ignored (missing or not a Java project dir): %s', p)
    return None


def _workspace_layout(session_workspace: Path) -> JavaProjectLayout:
    kind = classify_java_project_dir(session_workspace)
    if kind is not None:
        return _layout_for_dir(session_workspace, kind)
    return JavaProjectLayout(kind=JAVA_LAYOUT_LOOSE, root=session_workspace)


def detect_java_project_layout(
    session_workspace_root: Path,
    *,
    seed_relative_path: str | None,
    allow_workspace_walk: bool = True,
) -> JavaProjectLayout:
    """Return the project folder and classpath owner for Eclipse JDT LS.

    Priority:

    1. ``CLARA_JAVA_LSP_PROJECT_ROOT`` (absolute or relative to the session workspace).
    2. With a seed file: the nearest owner marker walking up from it. No marker means a
       loose folder rooted at the session workspace — a Maven/Gradle project elsewhere
       in the workspace never claims a file outside its own folder.
    3. Without a seed: the **deepest** Maven/Gradle project under the workspace.
    4. Otherwise the session workspace itself (its own markers, or loose).
    """

    session_workspace_root = Path(session_workspace_root).resolve()

    override = _env_override(session_workspace_root)
    if override is not None:
        return override

    if seed_relative_path:
        found = _walk_up_for_layout(session_workspace_root, seed_relative_path)
        if found is not None:
            logger.info(
                'java project layout from seed path=%s kind=%s root=%s',
                seed_relative_path,
                found.kind,
                found.root,
            )
            return found
        if _seed_start_dir(session_workspace_root, seed_relative_path) is not None:
            logger.info(
                'java seed path=%s has no build file; loose folder at workspace=%s',
                seed_relative_path,
                session_workspace_root,
            )
            return _workspace_layout(session_workspace_root)

    if allow_workspace_walk:
        discovered = _discover_deepest_project(session_workspace_root)
        if discovered is not None:
            kind = classify_java_project_dir(discovered) or JAVA_LAYOUT_MAVEN
            logger.info('java project root from discovery=%s kind=%s', discovered, kind)
            if kind == JAVA_LAYOUT_GRADLE:
                return JavaProjectLayout(kind=kind, root=_gradle_settings_root(discovered, session_workspace_root))
            return _layout_for_dir(discovered, kind)

    layout = _workspace_layout(session_workspace_root)
    if layout.is_loose and layout.config_path is None:
        logger.info('java project layout: loose folder at session workspace=%s', session_workspace_root)
    return layout


def resolve_java_project_root(
    session_workspace_root: Path,
    *,
    seed_relative_path: str | None,
    allow_workspace_walk: bool = True,
) -> Path:
    """Return the directory to use as LSP cwd / ``rootUri`` (see :func:`detect_java_project_layout`)."""

    return detect_java_project_layout(
        session_workspace_root,
        seed_relative_path=seed_relative_path,
        allow_workspace_walk=allow_workspace_walk,
    ).root
