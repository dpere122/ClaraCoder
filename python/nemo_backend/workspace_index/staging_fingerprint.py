"""Content fingerprint for staging slice of the semantic index."""

from __future__ import annotations

import hashlib
from pathlib import Path

from nemo_backend.workspace_index.staging_walk import iter_staging_index_files


def staging_content_fingerprint(session_id: str, graph_id: str, *, max_files: int) -> str:
    """SHA-256 of sorted ``relpath + mtime_ns + size`` for staging files under the session namespaces."""
    from nemo_backend.edit_staging import get_staging_root

    staging_root = get_staging_root().resolve()
    rows: list[str] = []
    for path in iter_staging_index_files(session_id, graph_id, max_files=max_files):
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(staging_root).as_posix()
        rows.append(f'{rel}\0{st.st_mtime_ns}\0{st.st_size}')
    body = '\n'.join(sorted(rows))
    return hashlib.sha256(body.encode('utf-8', errors='replace')).hexdigest()
