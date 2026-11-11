"""Find the project a Rust file belongs to, as a ``rust-analyzer.linkedProjects`` entry."""

from __future__ import annotations

import tomllib
from pathlib import Path, PurePosixPath

__all__ = ['find_rust_project']

_CARGO_MANIFEST = 'Cargo.toml'
_PROJECT_JSON_NAMES = ('rust-project.json', '.rust-project.json')
#: A real manifest is a few kilobytes; this stops a huge file from being parsed on every sync.
_MAX_MANIFEST_BYTES = 1024 * 1024


def _workspace_table(manifest: Path) -> dict | None:
    """The manifest's ``[workspace]`` table, or None when it has none or can't be read."""

    try:
        if manifest.stat().st_size > _MAX_MANIFEST_BYTES:
            return None
        data = tomllib.loads(manifest.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError):
        return None
    table = data.get('workspace')
    return table if isinstance(table, dict) else None


def _excludes(workspace_table: dict, workspace_dir: Path, crate_dir: Path) -> bool:
    """Whether ``workspace.exclude`` keeps ``crate_dir`` out of the cargo workspace at ``workspace_dir``."""

    excluded = workspace_table.get('exclude')
    if not isinstance(excluded, list):
        return False
    relative = PurePosixPath(crate_dir.relative_to(workspace_dir).as_posix())
    for entry in excluded:
        if not isinstance(entry, str) or not entry.strip():
            continue
        prefix = PurePosixPath(entry.strip().replace('\\', '/'))
        if relative == prefix or prefix in relative.parents:
            return True
    return False


def find_rust_project(workspace_root: Path, relative_posix_path: str) -> Path | None:
    """What rust-analyzer should load for this file, looking no higher than the workspace folder.

    - a ``rust-project.json`` nearer than any ``Cargo.toml`` wins;
    - otherwise the outermost ``Cargo.toml`` with a ``[workspace]`` table that doesn't exclude the
      file's crate, so members of one cargo workspace share one entry;
    - otherwise the nearest ``Cargo.toml`` (cargo finds a workspace above the folder by itself);
    - with no manifest at all, the file itself, which rust-analyzer analyzes as a standalone file.

    None when the path leaves the workspace folder.
    """

    root = Path(workspace_root).resolve()
    try:
        file_path = (root / relative_posix_path).resolve()
        file_path.relative_to(root)
    except (OSError, ValueError):
        return None

    manifests: list[Path] = []
    directory = file_path.parent
    while True:
        if not manifests:
            for name in _PROJECT_JSON_NAMES:
                candidate = directory / name
                if candidate.is_file():
                    return candidate
        candidate = directory / _CARGO_MANIFEST
        if candidate.is_file():
            manifests.append(candidate)
        if directory == root or directory.parent == directory:
            break
        directory = directory.parent

    if not manifests:
        return file_path
    nearest = manifests[0]
    for manifest in reversed(manifests):
        table = _workspace_table(manifest)
        if table is None:
            continue
        if manifest == nearest or not _excludes(table, manifest.parent, nearest.parent):
            return manifest
    return nearest
