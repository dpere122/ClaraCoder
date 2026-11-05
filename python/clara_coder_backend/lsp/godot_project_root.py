"""Find the Godot project a ``.gd`` file belongs to inside a workspace."""

from __future__ import annotations

import os
from pathlib import Path

GODOT_PROJECT_FILE = 'project.godot'

_MAX_SEARCH_DEPTH = 6
_MAX_DIRS_VISITED = 2000
# ``addons`` can hold whole demo projects; those are never the project being edited.
_SKIPPED_DIRS = frozenset({'addons', 'node_modules', 'target', 'build', 'dist', 'venv'})


def _nearest_above_seed(workspace_root: Path, seed_relative_path: str) -> Path | None:
    seed = (seed_relative_path or '').strip()
    if not seed:
        return None
    current = (workspace_root / seed).parent
    while True:
        try:
            current.relative_to(workspace_root)
        except ValueError:
            return None
        if (current / GODOT_PROJECT_FILE).is_file():
            return current
        if current == workspace_root:
            return None
        current = current.parent


def _shallowest_in_workspace(workspace_root: Path) -> Path | None:
    """Breadth-first, so a top-level game wins over a sample project buried below it."""

    level = [workspace_root]
    visited = 0
    for _depth in range(_MAX_SEARCH_DEPTH + 1):
        following: list[Path] = []
        for directory in level:
            if (directory / GODOT_PROJECT_FILE).is_file():
                return directory
            visited += 1
            if visited > _MAX_DIRS_VISITED:
                return None
            try:
                with os.scandir(directory) as entries:
                    following.extend(
                        Path(entry.path)
                        for entry in entries
                        if entry.is_dir(follow_symlinks=False)
                        and not entry.name.startswith('.')
                        and entry.name not in _SKIPPED_DIRS
                    )
            except OSError:
                continue
        following.sort()
        level = following
        if not level:
            return None
    return None


def resolve_godot_project_root(workspace_root: Path, seed_relative_path: str = '') -> Path:
    """The ``res://`` root for ``seed_relative_path``.

    Nearest ``project.godot`` above the file, else the shallowest one in the workspace (outside
    ``addons/`` and dot-directories), else the workspace root.
    """

    root = workspace_root.resolve()
    return _nearest_above_seed(root, seed_relative_path) or _shallowest_in_workspace(root) or root
