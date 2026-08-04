"""Restore workspace files materialized during staging test runs."""

from __future__ import annotations

import logging
from pathlib import Path

from clara_coder_backend.domain import SessionState
from clara_coder_backend.workspace.workspace_text_io import write_file_resolved

logger = logging.getLogger('clara.staging')

__all__ = [
    'restore_materialized_path',
    'rollback_test_run_materializations',
]


def restore_materialized_path(session: SessionState, rel_key: str) -> None:
    materialized = session.staging.test_run_materializations.get(rel_key)
    if materialized is None:
        return
    root = Path(session.workspace.workspace_path).resolve()
    target = (root / rel_key).resolve()
    if materialized.existed:
        write_file_resolved(
            target,
            materialized.original_text,
            materialized.disk_encoding,
            'crlf' if materialized.disk_newline == 'crlf' else 'lf',
        )
    else:
        target.unlink(missing_ok=True)
    session.staging.test_run_materializations.pop(rel_key, None)


def rollback_test_run_materializations(session: SessionState) -> None:
    """Restore any workspace files that were materialized for test runs but not approved."""

    for rel_key in list(session.staging.test_run_materializations.keys()):
        try:
            restore_materialized_path(session, rel_key)
        except Exception as exc:
            logger.warning('rollback_test_run_materializations failed path=%s err=%s', rel_key, exc)
