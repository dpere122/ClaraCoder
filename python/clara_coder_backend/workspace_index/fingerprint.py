"""Content fingerprint for invalidating a persisted workspace index."""

from __future__ import annotations

import hashlib
from pathlib import Path

from clara_coder_backend.workspace_index.walk import iter_index_workspace_files


def workspace_content_fingerprint(root: Path, *, max_files: int) -> str:
    """SHA-256 of sorted ``relpath + mtime_ns + size`` rows for up to *max_files* indexable files."""
    root = root.resolve()
    rows: list[str] = []
    for path in iter_index_workspace_files(root, max_files=max_files):
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(root).as_posix()
        rows.append(f'{rel}\0{st.st_mtime_ns}\0{st.st_size}')
    body = '\n'.join(sorted(rows))
    return hashlib.sha256(body.encode('utf-8', errors='replace')).hexdigest()
