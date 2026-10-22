"""LangChain tool: delete workspace files or directories.

Deletes run immediately and are journaled per turn (pre-delete bytes), so the user can reset them after the
turn like any other edit. A directory too large to journal (see
:data:`~clara_coder_backend.session.file_journal.TREE_SNAPSHOT_MAX_FILES`) cannot be restored. Those deletes
still pause for the user's confirmation through ``DeleteReviewAfterToolMiddleware``.
"""

from __future__ import annotations

import logging
import os
import shutil
import stat
import uuid
from pathlib import Path
from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp.file_policy import is_lsp_managed_path
from clara_coder_backend.lsp.manager import close_session_document
from clara_coder_backend.session.file_journal import TreeTooLargeError, emit_file_journal, snapshot_delete_payload
from clara_coder_backend.session.pause import stage_hitl_request, timed_approved_run
from clara_coder_backend.session.state import current_session_id, get_session, mutation_tools_blocked_reason
from clara_coder_backend.tools.tool_conventions import RELATIVE_PATH, describe
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path
from clara_coder_backend.workspace.path_locks import locked_path, note_batch_replaced

logger = logging.getLogger('clara.tools.delete')

DELETE_WORKSPACE_ENTRIES_NAME = 'delete_workspace_entries'

__all__ = [
    'DELETE_WORKSPACE_ENTRIES_NAME',
    'delete_confirm_sse_payload',
    'delete_workspace_entries',
    'execute_pending_delete_decision',
]


def _reject_reason(relative_path: str) -> str | None:
    p = (relative_path or '').strip().replace('\\', '/')
    if not p or p == '.':
        return 'Cannot delete the workspace root.'
    while p.startswith('./'):
        p = p[2:]
    if p == '.git' or p.startswith('.git/'):
        return 'Refusing to delete `.git` via this tool.'
    return None


def _make_writable_and_retry(func: Any, path: str, _exc: Any) -> None:
    """``shutil.rmtree`` error hook: clear read-only bits (e.g. ``.git`` objects on Windows) and retry once."""
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _perform_delete(root: Path, rel: str, recursive: bool) -> tuple[bool, str]:
    target = normalize_relative_path(root, rel)
    if not target.exists() and not target.is_symlink():
        return False, f'Path does not exist: `{rel}`.'
    try:
        if target.is_file() or target.is_symlink():
            # Same lock as the edit tools, so a parallel edit cannot write back a file it read before the delete.
            # Directory deletes lock nothing: an edit inside the tree racing them is not guarded.
            with locked_path(target) as key:
                target.unlink(missing_ok=True)
                note_batch_replaced(key)
            return True, f'Deleted file `{rel}`.'
        if any(target.iterdir()):
            if not recursive:
                return False, f'Directory `{rel}` is not empty. Pass `recursive=true` to delete it and its contents.'
            shutil.rmtree(target, onerror=_make_writable_and_retry)
            return True, f'Deleted directory `{rel}` and its contents.'
        target.rmdir()
        return True, f'Deleted empty directory `{rel}`.'
    except OSError as exc:
        logger.warning('delete failed path=%s err=%s', rel, exc)
        return False, f'Delete failed for `{rel}`: {exc}'


def _close_lsp_documents(session_id: str | None, rel: str, journal: dict | None) -> None:
    """Close LSP buffers for the deleted file, or for every file inside a deleted directory."""
    if not session_id:
        return
    paths = [rel]
    if journal and journal.get('treeEntries'):
        paths = [str(e.get('relativePath') or '') for e in journal['treeEntries']]
    for path in paths:
        if path and is_lsp_managed_path(path):
            try:
                close_session_document(path, session_id=session_id)
            except Exception as exc:
                logger.warning('LSP close failed after delete path=%s err=%s', path, exc)


def _delete_entries(
    session: SessionState,
    session_id: str | None,
    root: Path,
    entries: list[dict],
    journals: dict[str, dict | None],
) -> tuple[list[str], list[str]]:
    """Delete deepest paths first; journal each before removal. Returns ``(done_lines, failure_lines)``."""
    done: list[str] = []
    failed: list[str] = []
    for e in sorted(entries, key=lambda e: str(e['relative_path']).count('/'), reverse=True):
        rel = e['relative_path']
        if not normalize_relative_path(root, rel).exists():
            continue
        journal = journals.get(rel)
        ok, msg = _perform_delete(root, rel, bool(e['recursive']))
        if not ok:
            failed.append(msg)
            continue
        if journal:
            emit_file_journal(session, journal)
        _close_lsp_documents(session_id, rel, journal)
        done.append(msg)
    return done, failed


def _collect_entries(root: Path, paths: list[str], recursive: bool) -> tuple[list[dict], str | None]:
    entries: list[dict] = []
    seen: set[str] = set()
    for raw in paths:
        rel_in = (raw or '').strip().replace('\\', '/')
        if not rel_in or rel_in in seen:
            continue
        seen.add(rel_in)
        reason = _reject_reason(rel_in)
        if reason:
            return [], f'{reason} (`{rel_in}`)'
        try:
            target = normalize_relative_path(root, rel_in)
        except ValueError as exc:
            return [], str(exc)
        if not target.exists():
            return [], f'path does not exist: `{rel_in}`'
        is_dir = target.is_dir()
        if is_dir and not recursive and any(target.iterdir()):
            return [], f'directory `{rel_in}` is not empty; pass `recursive=true` to delete it and its contents'
        entries.append(
            {
                'relative_path': target.relative_to(root).as_posix(),
                'kind': 'directory' if is_dir else 'file',
                'recursive': recursive,
            }
        )
    if not entries:
        return [], '`relative_paths` must list at least one path'
    return entries, None


def delete_confirm_sse_payload(pending: dict) -> dict:
    """Shape for SSE ``deleteConfirm`` / frontend ``DeleteConfirmPayload`` (unrestorable directory deletes)."""
    return {
        'version': 1,
        'requestId': pending['request_id'],
        'entries': [
            {'relativePath': e['relative_path'], 'kind': e['kind'], 'recursive': bool(e.get('recursive'))}
            for e in pending['entries']
        ],
    }


def execute_pending_delete_decision(session: SessionState, *, confirm: bool, request_id: str | None) -> str:
    """Run after the user confirms/cancels an unrestorable delete. Returns the resume note."""
    pending = session.pending_delete_request
    if not pending:
        return ''
    session.pending_delete_request = None
    if request_id and pending.get('request_id') != request_id:
        return 'Delete confirmation ignored (stale or mismatched request).'
    if not confirm:
        return 'User cancelled the delete request.'
    root = Path(pending.get('workspace_root') or '')
    if not root.is_dir():
        return 'Delete failed: workspace root unavailable.'
    journals = {e['relative_path']: e.get('journal') for e in pending['entries']}
    with timed_approved_run(session):
        done, failed = _delete_entries(session, pending.get('session_id'), root, pending['entries'], journals)
    lines = done + failed
    if not lines:
        return 'Nothing to delete (paths were already removed).'
    return ('Delete failed:\n' if failed else '') + '\n'.join(lines)


@tool(
    DELETE_WORKSPACE_ENTRIES_NAME,
    description=describe(
        'Delete one or more workspace files or directories; runs immediately',
        when='removing files or folders that are no longer needed',
        not_='partial file edits (use `replace_workspace_lines` / `replace_workspace_snippet`)',
        shape=(
            'non-empty directories need `recursive=true`; a directory too large to restore after the turn '
            'asks the user first'
        ),
    ),
)
def delete_workspace_entries(
    relative_paths: Annotated[list[str], f'list of {RELATIVE_PATH}s'],
    recursive: Annotated[bool, 'required for non-empty directories'] = False,
) -> str:
    session_id = current_session_id.get()
    blocked = mutation_tools_blocked_reason(session_id)
    if blocked:
        return blocked
    if isinstance(relative_paths, str):
        relative_paths = [relative_paths]
    session = get_session(session_id)
    root = get_active_workspace_root()
    entries, err = _collect_entries(root, [str(p) for p in relative_paths or []], recursive)
    if err:
        return f'Tool error: {err}.'

    journals: dict[str, dict | None] = {}
    unrestorable: list[str] = []
    for e in entries:
        try:
            journals[e['relative_path']] = snapshot_delete_payload(root, e['relative_path'])
        except TreeTooLargeError as exc:
            journals[e['relative_path']] = None
            unrestorable.append(f"`{e['relative_path']}` ({exc})")

    if unrestorable:
        for e in entries:
            e['journal'] = journals.get(e['relative_path'])
        stage_hitl_request(
            session,
            'pending_delete_request',
            {
                'request_id': uuid.uuid4().hex,
                'entries': entries,
                'workspace_root': str(root.resolve()),
                'session_id': session_id,
            },
        )
        return (
            'Pending user confirmation: ' + ', '.join(unrestorable) + ' is too large to restore after the turn, '
            'so the user is asked before anything is removed.'
        )

    done, failed = _delete_entries(session, session_id, root, entries, journals)
    if failed:
        return 'Tool error: ' + '\n'.join(failed) + (('\nAlso: ' + '\n'.join(done)) if done else '')
    return '\n'.join(done) if done else 'Nothing to delete.'
