"""Restore workspace files from the write-through journal (pre-stage bytes)."""

from __future__ import annotations

import logging
from pathlib import Path

from clara_coder_backend.domain import SessionState
from clara_coder_backend.workspace.workspace_text_io import write_file_resolved

logger = logging.getLogger('clara.staging')

__all__ = [
    'restore_journal_path',
    'restore_materialized_path',
    'rollback_test_run_materializations',
    'rollback_unapplied_journals',
]


def _entry_applied(entry: object) -> bool:
    value = getattr(entry, 'workspace_applied', False)
    return value if isinstance(value, bool) else False


def restore_journal_path(session: SessionState, rel_key: str) -> None:
    """Write the first-stage baseline back to disk, or delete the file if it did not exist."""

    key = (rel_key or '').strip().replace('\\', '/')
    if not key:
        return
    entry = session.staging.pending_edit_stagings.get(key)
    if entry is None or _entry_applied(entry):
        session.staging.test_run_materializations.pop(key, None)
        return
    wp = (session.workspace_path or '').strip()
    if not wp:
        session.staging.test_run_materializations.pop(key, None)
        return
    target = (Path(wp).resolve() / key).resolve()
    existed = bool(getattr(entry, 'before_existed', True))
    if existed:
        write_file_resolved(
            target,
            str(getattr(entry, 'old_text', '') or ''),
            str(getattr(entry, 'disk_encoding', '') or 'utf-8'),
            'crlf' if str(getattr(entry, 'disk_newline', '') or 'lf').lower() == 'crlf' else 'lf',
        )
    else:
        target.unlink(missing_ok=True)
        current = target.parent
        root = Path(wp).resolve()
        while current != root and current.is_dir():
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent
    session.staging.test_run_materializations.pop(key, None)


def restore_materialized_path(session: SessionState, rel_key: str) -> None:
    """Restore one path from the write-through journal (legacy name kept for callers)."""

    restore_journal_path(session, rel_key)


def rollback_unapplied_journals(session: SessionState) -> None:
    """Restore every pending (not yet kept) write-through path."""

    pending = session.staging.pending_edit_stagings
    for rel_key in list(pending.keys()):
        try:
            restore_journal_path(session, rel_key)
        except Exception as exc:
            logger.warning('rollback_unapplied_journals failed path=%s err=%s', rel_key, exc)


def rollback_test_run_materializations(session: SessionState) -> None:
    """Restore paths recorded in the legacy materialization map (and their journals)."""

    for rel_key in list(session.staging.test_run_materializations.keys()):
        try:
            restore_journal_path(session, rel_key)
        except Exception as exc:
            logger.warning('rollback_test_run_materializations failed path=%s err=%s', rel_key, exc)
