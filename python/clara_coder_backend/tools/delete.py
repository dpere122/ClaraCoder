"""LangChain tool: delete workspace files or directories with optional HITL when auto-apply is off."""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path
from typing import Annotated

logger = logging.getLogger('clara.tools.delete')

from langchain_core.tools import tool

from clara_coder_backend.staging import edit_staging
from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp.file_policy import is_lsp_managed_path
from clara_coder_backend.lsp.manager import close_session_document
from clara_coder_backend.session.file_journal import emit_file_journal, snapshot_delete_payload
from clara_coder_backend.session.state import current_session_id, get_session, mutation_tools_blocked_reason
from clara_coder_backend.tools.tool_conventions import RELATIVE_PATH, describe
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path

DELETE_WORKSPACE_ENTRY_NAME = 'delete_workspace_entry'
BATCH_DELETE_WORKSPACE_ENTRIES_NAME = 'batch_delete_workspace_entries'

__all__ = [
    'BATCH_DELETE_WORKSPACE_ENTRIES_NAME',
    'DELETE_WORKSPACE_ENTRY_NAME',
    'batch_delete_workspace_entries',
    'delete_workspace_entry',
    'execute_pending_delete_decision',
    'delete_confirm_sse_payload',
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
    base = {'version': 1, 'requestId': pending['request_id']}
    if pending.get('batch') and pending.get('entries'):
        return {
            **base,
            'entries': [
                {
                    'relativePath': e['relative_path'],
                    'kind': e['kind'],
                    'recursive': bool(e.get('recursive')),
                }
                for e in pending['entries']
            ],
        }
    return {
        **base,
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
    root = Path(pending.get('workspace_root') or '')
    session_id = str(pending.get('session_id') or '').strip() or None
    if not root.is_dir():
        return f'Delete failed (request {rid}): workspace root unavailable.'

    if pending.get('batch') and pending.get('entries'):
        entries = list(pending['entries'])
        entries.sort(key=lambda e: str(e.get('relative_path', '')).count('/'), reverse=True)
        lines: list[str] = []
        any_fail = False
        for e in entries:
            rel = str(e.get('relative_path', '')).strip()
            rec = bool(e.get('recursive'))
            try:
                target = normalize_relative_path(root, rel)
            except ValueError as exc:
                any_fail = True
                lines.append(f'`{rel}`: {exc}')
                continue
            if not target.exists():
                continue
            pending_journal = snapshot_delete_payload(root, rel)
            ok, msg = _perform_delete(root, rel, rec)
            if ok and pending_journal:
                emit_file_journal(session, pending_journal)
            if ok:
                lines.append(msg)
                if session_id and is_lsp_managed_path(rel):
                    try:
                        close_session_document(rel, session_id=session_id)
                    except Exception as exc:
                        logger.warning('LSP close failed after delete path=%s err=%s', rel, exc)
                edit_staging.delete_snapshot_path(session, rel)
            else:
                any_fail = True
                lines.append(f'`{rel}`: {msg}')
        if not lines and not any_fail:
            return 'Nothing to delete (paths were already removed).'
        summary = '\n'.join(lines)
        return f'Delete failed:\n{summary}' if any_fail else summary

    rel = pending.get('relative_path', '')
    rec = bool(pending.get('recursive'))
    pending_journal = snapshot_delete_payload(root, rel)
    ok, msg = _perform_delete(root, rel, rec)
    if ok and pending_journal:
        emit_file_journal(session, pending_journal)
    if ok and session_id and is_lsp_managed_path(rel):
        try:
            close_session_document(rel, session_id=session_id)
        except Exception as exc:
            logger.warning('LSP close failed after delete path=%s err=%s', rel, exc)
    if ok:
        edit_staging.delete_snapshot_path(session, rel)
    return msg if ok else f'Delete failed: {msg}'


@tool(DELETE_WORKSPACE_ENTRY_NAME, description=describe('Delete a file or directory under the workspace.',
        when='removing files or dirs that are no longer needed.',
        not_='partial file edits (use update or line-range tools).',
        shape=(
            f'`relative_path` {RELATIVE_PATH}; non-empty dir needs `recursive=true`; '
            'Editor mode required; HITL confirm when auto-apply off.'
        ),))
def delete_workspace_entry(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    recursive: bool = False,
) -> str:

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
        pending_journal = snapshot_delete_payload(root, rel_display)
        ok, msg = _perform_delete(root, rel_clean, recursive)
        if ok and pending_journal:
            emit_file_journal(session, pending_journal)
        if ok and is_lsp_managed_path(rel_display):
            try:
                close_session_document(rel_display, session_id=session_id)
            except Exception as exc:
                logger.warning('LSP close failed after auto delete path=%s err=%s', rel_display, exc)
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


def _normalize_path_list(relative_paths: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in relative_paths:
        p = (raw or '').strip().replace('\\', '/')
        if not p or p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def _collect_delete_entries(root: Path, paths: list[str], recursive: bool) -> tuple[list[dict] | None, str | None]:
    """Validate paths and build pending `entries` list. Returns (entries, error_message)."""
    if not paths:
        return None, 'Tool error: `relative_paths` must be a non-empty list.'
    entries: list[dict] = []
    for rel_clean in paths:
        reason = _reject_reason(rel_clean)
        if reason:
            return None, f'Tool error: {reason} (`{rel_clean}`).'
        try:
            target = normalize_relative_path(root, rel_clean)
        except ValueError as exc:
            return None, f'Tool error: {exc}'
        if not target.exists():
            return None, f'Tool error: path does not exist: `{rel_clean}`.'
        is_dir = target.is_dir()
        if is_dir and any(target.iterdir()) and not recursive:
            return (
                None,
                'Tool error: directory is not empty; pass `recursive=true` to delete it and all contents, '
                f'or delete files inside first (`{rel_clean}`).',
            )
        rel_display = target.relative_to(root).as_posix()
        entries.append(
            {
                'relative_path': rel_display,
                'kind': 'directory' if is_dir else 'file',
                'recursive': recursive,
            }
        )
    return entries, None


@tool(BATCH_DELETE_WORKSPACE_ENTRIES_NAME, description=describe('Delete multiple workspace files and/or directories in one tool call.',
        when='batch cleanup of several paths.',
        not_='single-file delete when one path suffices (use `delete_workspace_entry`).',
        shape=(
            f'same rules as `delete_workspace_entry`: non-empty dirs need `recursive=true`; '
            'Editor mode required; single UI confirmation when auto-apply off.'
        ),))
def batch_delete_workspace_entries(
    relative_paths: Annotated[list[str], 'workspace-relative POSIX paths'],
    recursive: bool = False,
) -> str:

    session_id = current_session_id.get()
    blocked = mutation_tools_blocked_reason(session_id)
    if blocked:
        return blocked

    session = get_session(session_id)
    root = get_active_workspace_root()
    if not isinstance(relative_paths, list):
        return 'Tool error: `relative_paths` must be a list of path strings.'
    paths = _normalize_path_list([str(p) for p in relative_paths])
    entries, err = _collect_delete_entries(root, paths, recursive)
    if err or not entries:
        return err or 'Tool error: no valid paths to delete.'

    if session.auto_apply_mode:
        entries.sort(key=lambda e: str(e['relative_path']).count('/'), reverse=True)
        lines: list[str] = []
        for e in entries:
            rel = e['relative_path']
            rec = bool(e['recursive'])
            try:
                target = normalize_relative_path(root, rel)
            except ValueError as exc:
                return f'Tool error: {exc}'
            if not target.exists():
                continue
            pending_journal = snapshot_delete_payload(root, rel)
            ok, msg = _perform_delete(root, rel, rec)
            if ok and pending_journal:
                emit_file_journal(session, pending_journal)
            if ok:
                lines.append(msg)
                if is_lsp_managed_path(rel):
                    try:
                        close_session_document(rel, session_id=session_id)
                    except Exception as exc:
                        logger.warning('LSP close failed after auto delete path=%s err=%s', rel, exc)
                edit_staging.delete_snapshot_path(session, rel)
            else:
                return f'Tool error: {msg}'
        return '\n'.join(lines) if lines else 'Nothing to delete.'

    session.pending_delete_request = {
        'request_id': uuid.uuid4().hex,
        'batch': True,
        'entries': entries,
        'workspace_root': str(root.resolve()),
        'session_id': session_id,
    }
    n = len(entries)
    return (
        f'Pending user confirmation to delete {n} workspace path(s). '
        'The UI will ask the user to confirm once before anything is removed from disk.'
    )
