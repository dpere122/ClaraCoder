"""Walk workspace files for semantic indexing (ignores align with workspace tools; PDFs included)."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from clara_coder_backend.workspace_ignore import (
    get_workspace_ignore_rules_cached,
    should_ignore_workspace_entry,
    workspace_expose_all_files,
)
from clara_coder_backend.workspace_ignore import SEARCH_SKIP_SUFFIXES

# Same as grep search skips except PDFs are indexed semantically.
_INDEX_SKIP_SUFFIXES: frozenset[str] = frozenset(x for x in SEARCH_SKIP_SUFFIXES if x != '.pdf')


def iter_index_workspace_files(root: Path, *, max_files: int) -> Iterator[Path]:
    """Yield files under *root* respecting ignore rules, capped at *max_files*."""
    root = root.resolve()
    ignore_rules = get_workspace_ignore_rules_cached(root)
    count = 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        rdir = Path(dirpath)
        rel_dir_raw = rdir.relative_to(root).as_posix()
        rel_dir = '' if rel_dir_raw == '.' else rel_dir_raw

        kept: list[str] = []
        for d in dirnames:
            rel_path = f'{rel_dir}/{d}' if rel_dir else d
            if should_ignore_workspace_entry(d, rel_path, ignore_rules):
                continue
            kept.append(d)
        dirnames[:] = kept

        for fn in filenames:
            if count >= max_files:
                return
            rel_path = f'{rel_dir}/{fn}' if rel_dir else fn
            if should_ignore_workspace_entry(fn, rel_path, ignore_rules):
                continue
            sfx = Path(fn).suffix.lower()
            if not workspace_expose_all_files() and sfx in _INDEX_SKIP_SUFFIXES:
                continue
            count += 1
            yield rdir / fn


def is_indexable_workspace_relative_path(root: Path, rel_posix: str) -> bool:
    """True if *rel_posix* under *root* would be yielded by :func:`iter_index_workspace_files` (single-path check)."""
    root = root.resolve()
    rel = rel_posix.strip().replace('\\', '/').lstrip('/')
    if not rel or rel.startswith('../'):
        return False
    ignore_rules = get_workspace_ignore_rules_cached(root)
    fn = Path(rel).name
    if should_ignore_workspace_entry(fn, rel, ignore_rules):
        return False
    sfx = Path(fn).suffix.lower()
    if not workspace_expose_all_files() and sfx in _INDEX_SKIP_SUFFIXES:
        return False
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return candidate.is_file()
