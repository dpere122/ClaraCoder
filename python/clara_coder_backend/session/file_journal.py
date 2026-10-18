"""Emit ``file_journal`` SSE events when a workspace mutation lands on disk.

Edits write straight to disk; Electron persists one journal row per path per turn (the pre-turn bytes) so the
user can review and reset each turn's files afterwards. Only the **first** mutation of a path in a turn is
journaled—later writes in the same turn would otherwise overwrite the restore baseline.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Literal

from clara_coder_backend.domain import SessionState
from clara_coder_backend.workspace.workspace_text_io import decode_for_tools, detect_newline_preference

logger = logging.getLogger('clara.session.file_journal')

FILE_JOURNAL_MAX_CHARS = 2_000_000
#: Directory deletes above these caps cannot be restored, so they still ask the user first.
TREE_SNAPSHOT_MAX_FILES = 2_000
TREE_SNAPSHOT_MAX_BYTES = 20_000_000
_TREE_SNAPSHOT_SKIP_DIRS = frozenset({'.git', 'node_modules', '.venv', 'venv', '__pycache__'})

FileJournalOp = Literal['create', 'modify', 'delete', 'delete-tree', 'copy']


def snapshot_text_file(path: Path) -> dict[str, str] | None:
    """Read a text file for journal before-content. None if missing, binary, or too large."""
    try:
        if not path.is_file() or path.stat().st_size > FILE_JOURNAL_MAX_CHARS * 4:
            return None
        raw = path.read_bytes()
    except OSError as exc:
        logger.warning('file journal snapshot read failed path=%s err=%s', path, exc)
        return None
    if len(raw) > FILE_JOURNAL_MAX_CHARS * 4 or b'\x00' in raw:
        return None
    try:
        text = decode_for_tools(raw, 'utf-8')
    except Exception:
        return None
    if len(text) > FILE_JOURNAL_MAX_CHARS:
        return None
    return {
        'content': text,
        'encoding': 'utf-8',
        'newline': detect_newline_preference(raw),
    }


class TreeTooLargeError(Exception):
    """Raised when a directory is too large to journal for undo."""


def snapshot_tree(root: Path, directory: Path) -> list[dict[str, str]]:
    """Snapshot text files under *directory* as workspace-relative entries.

    Raises :class:`TreeTooLargeError` past :data:`TREE_SNAPSHOT_MAX_FILES` / :data:`TREE_SNAPSHOT_MAX_BYTES`
    (sizes come from ``stat`` before any read) or when the tree holds a dependency/VCS directory.
    """
    entries: list[dict[str, str]] = []
    if not directory.is_dir():
        return entries
    root_resolved = root.resolve()
    files: list[Path] = []
    total_bytes = 0
    for child in directory.rglob('*'):
        if child.is_dir():
            if child.name in _TREE_SNAPSHOT_SKIP_DIRS:
                raise TreeTooLargeError(f'contains `{child.name}/`')
            continue
        try:
            total_bytes += child.stat().st_size
        except OSError:
            continue
        files.append(child)
        if len(files) > TREE_SNAPSHOT_MAX_FILES or total_bytes > TREE_SNAPSHOT_MAX_BYTES:
            raise TreeTooLargeError(f'more than {TREE_SNAPSHOT_MAX_FILES} files or {TREE_SNAPSHOT_MAX_BYTES} bytes')
    for child in files:
        snap = snapshot_text_file(child)
        if snap is None:
            continue
        try:
            rel = child.resolve().relative_to(root_resolved).as_posix()
        except ValueError:
            continue
        entries.append(
            {
                'relativePath': rel,
                'content': snap['content'],
                'encoding': snap['encoding'],
                'newline': snap['newline'],
            }
        )
    return entries


def file_journal_payload(
    *,
    user_message_id: str,
    op: FileJournalOp,
    relative_path: str,
    before_content: str | None = None,
    before_encoding: str | None = None,
    before_newline: str | None = None,
    dest_relative_path: str | None = None,
    tree_entries: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        'userMessageId': user_message_id,
        'op': op,
        'relativePath': relative_path,
    }
    if before_content is not None:
        payload['beforeContent'] = before_content
    if before_encoding:
        payload['beforeEncoding'] = before_encoding
    if before_newline in ('lf', 'crlf'):
        payload['beforeNewline'] = before_newline
    if dest_relative_path:
        payload['destRelativePath'] = dest_relative_path
    if tree_entries:
        payload['treeEntries'] = tree_entries
    return payload


def first_mutation_this_turn(session: SessionState, relative_path: str) -> bool:
    """Record *relative_path* for the current turn; True only on its first mutation in this turn."""
    turn_id = (getattr(session, 'current_user_message_id', '') or '').strip()
    edits = session.edits
    if edits.journal_turn_id != turn_id:
        edits.journal_turn_id = turn_id
        edits.journaled_paths = set()
    key = (relative_path or '').strip().replace('\\', '/')
    if key in edits.journaled_paths:
        return False
    edits.journaled_paths.add(key)
    return True


def emit_file_journal(session: SessionState, payload: dict[str, Any]) -> None:
    """Queue a ``file_journal`` HITL SSE item for the first mutation of a path in the current turn."""
    turn_id = (getattr(session, 'current_user_message_id', '') or '').strip()
    if not turn_id:
        return
    if not first_mutation_this_turn(session, str(payload.get('relativePath') or '')):
        return
    body = dict(payload)
    body['userMessageId'] = turn_id
    queue = session.hitl_sse_queue
    if queue is None:
        logger.debug('file journal dropped (no HITL SSE queue) path=%s', body.get('relativePath'))
        return
    try:
        queue.put_nowait(('file_journal', body))
    except Exception as exc:
        logger.warning('file journal enqueue failed path=%s err=%s', body.get('relativePath'), exc)


def emit_edit_journal(
    session: SessionState,
    relative_path: str,
    old_text: str,
    *,
    before_existed: bool,
    encoding: str,
    newline: str,
) -> None:
    existed = before_existed
    emit_file_journal(
        session,
        file_journal_payload(
            user_message_id='',
            op='modify' if existed else 'create',
            relative_path=relative_path,
            before_content=old_text if existed else None,
            before_encoding=encoding,
            before_newline=newline if newline in ('lf', 'crlf') else 'lf',
        ),
    )


def snapshot_delete_payload(root: Path, relative_path: str) -> dict[str, Any] | None:
    try:
        target = (root / relative_path).resolve()
        target.relative_to(root.resolve())
    except ValueError:
        return None
    if not target.exists():
        return None
    if target.is_dir():
        return file_journal_payload(
            user_message_id='',
            op='delete-tree',
            relative_path=relative_path,
            tree_entries=snapshot_tree(root, target),
        )
    snap = snapshot_text_file(target)
    return file_journal_payload(
        user_message_id='',
        op='delete',
        relative_path=relative_path,
        before_content=snap['content'] if snap else None,
        before_encoding=snap['encoding'] if snap else None,
        before_newline=snap['newline'] if snap else None,
    )


def emit_delete_journal(session: SessionState, root: Path, relative_path: str) -> None:
    payload = snapshot_delete_payload(root, relative_path)
    if payload:
        emit_file_journal(session, payload)


def emit_copy_journal(
    session: SessionState,
    dest_relative_path: str,
    *,
    before_content: str | None = None,
    before_encoding: str | None = None,
    before_newline: str | None = None,
) -> None:
    emit_file_journal(
        session,
        file_journal_payload(
            user_message_id='',
            op='copy',
            relative_path=dest_relative_path,
            dest_relative_path=dest_relative_path,
            before_content=before_content,
            before_encoding=before_encoding,
            before_newline=before_newline,
        ),
    )
