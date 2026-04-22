"""Walk staging files eligible for semantic indexing (session / graph scoped)."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path


def staging_session_roots(session_id: str, graph_id: str) -> list[Path]:
    """Directories under the staging root that belong to this session (and optional graph)."""
    from nemo_backend.edit_staging import _graph_session_dir

    roots: list[Path] = []
    sid = (session_id or '').strip()
    if not sid:
        return roots
    roots.append(_graph_session_dir(sid, ''))
    gid = (graph_id or '').strip()
    if gid:
        gdir = _graph_session_dir(sid, gid)
        if gdir.resolve() != roots[0].resolve():
            roots.append(gdir)
    return roots


def iter_staging_index_files(session_id: str, graph_id: str, *, max_files: int) -> Iterator[Path]:
    """Yield files under allowed staging subtrees, capped at *max_files*."""
    from nemo_backend.edit_staging import get_staging_root

    staging_root = get_staging_root().resolve()
    count = 0
    for base in staging_session_roots(session_id, graph_id):
        base = base.resolve()
        if not base.is_dir():
            continue
        for dirpath, _, filenames in os.walk(base, topdown=True):
            if count >= max_files:
                return
            dpath = Path(dirpath)
            for fn in filenames:
                if count >= max_files:
                    return
                p = dpath / fn
                try:
                    p.relative_to(staging_root)
                except ValueError:
                    continue
                if p.is_file():
                    count += 1
                    yield p
