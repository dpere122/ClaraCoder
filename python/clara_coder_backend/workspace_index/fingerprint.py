"""Content fingerprint for invalidating a persisted workspace index."""

from __future__ import annotations

import hashlib
from pathlib import Path

from clara_coder_backend.workspace_index.walk import iter_index_workspace_files


def workspace_file_entries(root: Path, *, max_files: int) -> dict[str, str]:
    """``relpath -> 'mtime_ns:size'`` for up to *max_files* indexable files (one tree walk).

    Persisted in the index manifest so a stale index can be reconciled file-by-file
    instead of being re-embedded from scratch.
    """
    root = root.resolve()
    entries: dict[str, str] = {}
    for path in iter_index_workspace_files(root, max_files=max_files):
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(root).as_posix()
        entries[rel] = f'{st.st_mtime_ns}:{st.st_size}'
    return entries


def fingerprint_for_entries(entries: dict[str, str]) -> str:
    """SHA-256 of sorted ``relpath + mtime_ns + size`` rows (same digest as before entries existed)."""
    rows: list[str] = []
    for rel, stamp in entries.items():
        mtime_ns, _, size = stamp.partition(':')
        rows.append(f'{rel}\0{mtime_ns}\0{size}')
    body = '\n'.join(sorted(rows))
    return hashlib.sha256(body.encode('utf-8', errors='replace')).hexdigest()


def workspace_content_fingerprint(root: Path, *, max_files: int) -> str:
    """SHA-256 of sorted ``relpath + mtime_ns + size`` rows for up to *max_files* indexable files."""
    return fingerprint_for_entries(workspace_file_entries(root, max_files=max_files))
