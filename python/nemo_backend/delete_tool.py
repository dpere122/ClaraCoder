"""LangChain tool: delete workspace files or directories with optional HITL when auto-apply is off."""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path

logger = logging.getLogger('nemo.tools.delete')

from langchain_core.tools import tool

from nemo_backend import edit_staging
from nemo_backend.domain import SessionState
from nemo_backend.lsp.file_policy import is_lsp_managed_path
from nemo_backend.lsp.manager import close_session_document
from nemo_backend.state import current_session_id, get_session, mutation_tools_blocked_reason
from nemo_backend.workspace_tools import get_active_workspace_root, normalize_relative_path

DELETE_WORKSPACE_ENTRY_NAME = 'delete_workspace_entry'

__all__ = ['DELETE_WORKSPACE_ENTRY_NAME', 'delete_workspace_entry', 'execute_pending_delete_decision', 'delete_confirm_sse_payload']


def _reject_reason(relative_path: str) -> str | None:
    p = (relative_path or '').strip().replace('\\', '/')
    if not p or p == '.':
        return 'Cannot delete the workspace root.'
    while p.startswith('./'):
        p = p[2:]
    if p == '.git' or p.startswith('.git/'):
        return 'Refusing to delete `.git` via this tool.'
    return None


def _perform_delete(root: Path, relative_path: str, recursive: bool) -> tuple[bool, str]:
    reason = _reject_reason(relative_path)
    if reason:
        return False, reason
    try:
        target = normalize_relative_path(root, relative_path)
    except ValueError as exc:
        return False, str(exc)
    try:
        target.relative_to(root)
    except ValueError:
        return False, 'Path is outside the workspace.'

    if not target.exists():
        return False, f'Path does not exist: `{relative_path}`.'

    rel_display = target.relative_to(root).as_posix()
    try:
        if target.is_file() or target.is_symlink():
            target.unlink()
            return True, f'Deleted file `{rel_display}`.'
        if target.is_dir():
            if any(target.iterdir()) and not recursive:
                return (
                    False,
                    f'Directory `{rel_display}` is not empty. Pass `recursive=true` to delete it and all contents.',
                )
            if recursive:
                shutil.rmtree(target)
                return True, f'Deleted directory `{rel_display}` and its contents (recursive).'
            target.rmdir()
            return True, f'Deleted empty directory `{rel_display}`.'
        return False, f'Not a file or directory: `{rel_display}`.'
    except OSError as exc:
        logger.warning('delete failed path=%s err=%s', relative_path, exc)
        return False, f'Delete failed: {exc}'


def delete_confirm_sse_payload(pending: dict) -> dict:
    """Shape for SSE `deleteConfirm` / frontend `DeleteConfirmPayload`."""
    return {
        'version': 1,
        'requestId': pending['request_id'],
        'relativePath': pending['relative_path'],
        'kind': pending['kind'],
        'recursive': bool(pending.get('recursive')),
    }


def execute_pending_delete_decision(session: SessionState, *, confirm: bool, request_id: str | None) -> str:
    """Run after user confirms/cancels in UI. Clears ``pending_delete_request``. Returns note for HumanMessage."""
    pending = session.pending_delete_request
    if not pending:
        return ''
    if request_id and pending.get('request_id') != request_id:
        session.pending_delete_request = None
        return 'Delete confirmation ignored (stale or mismatched request).'
    session.pending_delete_request = None
    if not confirm:
        return 'User cancelled the delete request.'
    rid = pending.get('request_id', '')
    rel = pending.get('relative_path', '')
    rec = bool(pending.get('recursive'))
    root = Path(pending.get('workspace_root') or '')
    session_id = str(pending.get('session_id') or '').strip() or None
    if not root.is_dir():
        return f'Delete failed (request {rid}): workspace root unavailable.'
    ok, msg = _perform_delete(root, rel, rec)
    if ok and session_id and is_lsp_managed_path(rel):
        try:
            close_session_document(rel, session_id=session_id, scope='workspace')
        except Exception as exc:
            logger.warning('python LSP close failed after delete path=%s err=%s', rel, exc)
    if ok:
        edit_staging.delete_snapshot_path(session, rel)
    return msg if ok else f'Delete failed: {msg}'


@tool(DELETE_WORKSPACE_ENTRY_NAME)
def delete_workspace_entry(relative_path: str, recursive: bool = False) -> str:
    """Delete a file or directory under the workspace (relative path only).

    For a non-empty directory you must pass recursive=true (destructive). Empty directories can be removed with
    recursive=false. Requires Editor mode. If the user has not enabled auto-apply, deletion waits for explicit
    confirmation in the UI."""

    session_id = current_session_id.get()
    blocked = mutation_tools_blocked_reason(session_id)
    if blocked:
        return blocked

    session = get_session(session_id)
    reason = _reject_reason(relative_path)
    if reason:
        return f'Tool error: {reason}'

    root = get_active_workspace_root()
    rel_clean = (relative_path or '').strip().replace('\\', '/')
    try:
        target = normalize_relative_path(root, rel_clean)
    except ValueError as exc:
        return f'Tool error: {exc}'

    if not target.exists():
        return f'Tool error: path does not exist: `{rel_clean}`.'

    is_dir = target.is_dir()
    if is_dir and any(target.iterdir()) and not recursive:
        return (
            'Tool error: directory is not empty; pass `recursive=true` to delete it and all contents, '
            'or delete files inside first.'
        )

    rel_display = target.relative_to(root).as_posix()

    if session.auto_apply_mode:
        ok, msg = _perform_delete(root, rel_clean, recursive)
        if ok and is_lsp_managed_path(rel_display):
            try:
                close_session_document(rel_display, session_id=session_id, scope='workspace')
            except Exception as exc:
                logger.warning('python LSP close failed after auto delete path=%s err=%s', rel_display, exc)
        if ok:
            edit_staging.delete_snapshot_path(session, rel_display)
        return msg if ok else f'Tool error: {msg}'

    session.pending_delete_request = {
        'request_id': uuid.uuid4().hex,
        'relative_path': rel_display,
        'kind': 'directory' if is_dir else 'file',
        'recursive': recursive,
        'workspace_root': str(root.resolve()),
        'session_id': session_id,
    }
    return (
        f'Pending user confirmation to delete {"directory" if is_dir else "file"} `{rel_display}`'
        f'{" (recursive)" if recursive and is_dir else ""}. '
        'The UI will ask the user to confirm before anything is removed from disk.'
    )
