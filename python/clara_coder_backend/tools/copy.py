"""LangChain tool: copy one or more workspace files with optional HITL confirmation."""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from clara_coder_backend.domain import SessionState
from clara_coder_backend.state import current_session_id, get_session, mutation_tools_blocked_reason
from clara_coder_backend.tools.tool_conventions import RELATIVE_PATH, describe
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path

logger = logging.getLogger('clara.tools.copy')

COPY_WORKSPACE_FILES_NAME = 'copy_workspace_files'

__all__ = [
    'COPY_WORKSPACE_FILES_NAME',
    'CopyWorkspaceFileItem',
    'copy_confirm_sse_payload',
    'copy_workspace_files',
    'execute_pending_copy_decision',
]


class CopyWorkspaceFileItem(BaseModel):
    """One workspace-relative file copy request."""

    source_path: str = Field(description='Existing workspace-relative file path to copy from.')
    destination_path: str = Field(
        description='Workspace-relative file path to copy to. Parent directories are created automatically.'
    )


def _reject_path(relative_path: str, *, role: str) -> str | None:
    p = (relative_path or '').strip().replace('\\', '/')
    if not p or p == '.':
        return f'{role} path must point to a file under the workspace.'
    while p.startswith('./'):
        p = p[2:]
    if p == '.git' or p.startswith('.git/'):
        return f'Refusing to use `.git` as a {role.lower()} path.'
    return None


def _preview_pairs(pairs: list[tuple[str, str]], *, limit: int = 4) -> str:
    if not pairs:
        return ''
    shown = [f'`{src}` -> `{dest}`' for src, dest in pairs[:limit]]
    extra = len(pairs) - min(len(pairs), limit)
    if extra > 0:
        shown.append(f'... and {extra} more')
    return '; '.join(shown)


def _validate_copy_batch(
    root: Path, copies: list[CopyWorkspaceFileItem | dict]
) -> tuple[list[tuple[Path, Path]], list[tuple[str, str]]] | tuple[None, str]:
    if not copies:
        return None, 'At least one copy item is required.'
    if len(copies) > 100:
        return None, 'Copy requests are limited to 100 files at a time.'

    normalized: list[tuple[Path, Path]] = []
    preview: list[tuple[str, str]] = []
    seen_destinations: set[str] = set()
    root_resolved = root.resolve()

    for index, raw in enumerate(copies, start=1):
        item = raw if isinstance(raw, CopyWorkspaceFileItem) else CopyWorkspaceFileItem.model_validate(raw)
        src_input = item.source_path.strip()
        dest_input = item.destination_path.strip()

        for role, value in (('Source', src_input), ('Destination', dest_input)):
            reason = _reject_path(value, role=role)
            if reason:
                return None, f'Item {index}: {reason}'

        try:
            src = normalize_relative_path(root_resolved, src_input)
            dest = normalize_relative_path(root_resolved, dest_input)
        except ValueError as exc:
            return None, f'Item {index}: {exc}'

        if not src.exists():
            return None, f'Item {index}: source file does not exist: `{src_input}`.'
        if not src.is_file():
            return None, f'Item {index}: source path is not a file: `{src_input}`.'
        if src == dest:
            return None, f'Item {index}: source and destination are the same path: `{src_input}`.'
        if dest.exists() and dest.is_dir():
            return None, f'Item {index}: destination path is an existing directory: `{dest_input}`.'

        rel_src = src.relative_to(root_resolved).as_posix()
        rel_dest = dest.relative_to(root_resolved).as_posix()
        if rel_dest in seen_destinations:
            return None, f'Item {index}: duplicate destination path in the same request: `{rel_dest}`.'
        seen_destinations.add(rel_dest)

        normalized.append((src, dest))
        preview.append((rel_src, rel_dest))

    return normalized, preview


def _perform_copy(root: Path, copies: list[CopyWorkspaceFileItem | dict], overwrite: bool) -> tuple[bool, str]:
    validated, detail = _validate_copy_batch(root, copies)
    if validated is None:
        return False, detail

    copy_pairs = validated
    preview_pairs = detail
    for _src, dest in copy_pairs:
        if dest.exists() and not overwrite:
            rel_dest = dest.relative_to(root.resolve()).as_posix()
            return False, f'Destination already exists: `{rel_dest}`. Pass `overwrite=true` to replace it.'

    try:
        for src, dest in copy_pairs:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
    except OSError as exc:
        logger.warning('copy failed err=%s', exc)
        return False, f'Copy failed: {exc}'

    summary = _preview_pairs(preview_pairs)
    if overwrite:
        return True, f'Copied {len(copy_pairs)} file(s) with overwrite enabled. {summary}'
    return True, f'Copied {len(copy_pairs)} file(s). {summary}'


def copy_confirm_sse_payload(pending: dict) -> dict:
    """Shape for SSE `copyConfirm` / frontend `CopyConfirmPayload`."""

    return {
        'version': 1,
        'requestId': pending['request_id'],
        'copies': [
            {'sourcePath': item['source_path'], 'destinationPath': item['destination_path']}
            for item in pending['copies']
        ],
        'overwrite': bool(pending.get('overwrite')),
    }


def execute_pending_copy_decision(session: SessionState, *, confirm: bool, request_id: str | None) -> str:
    """Run after user confirms/cancels in UI. Clears ``pending_copy_request`` and returns the resume note."""

    pending = session.pending_copy_request
    if not pending:
        return ''
    if request_id and pending.get('request_id') != request_id:
        session.pending_copy_request = None
        return 'Copy confirmation ignored (stale or mismatched request).'
    session.pending_copy_request = None
    if not confirm:
        return 'User cancelled the copy request.'
    root = Path(pending.get('workspace_root') or '')
    if not root.is_dir():
        return 'Copy failed: workspace root unavailable.'
    ok, msg = _perform_copy(root, pending.get('copies') or [], bool(pending.get('overwrite')))
    return msg if ok else f'Copy failed: {msg}'


@tool(COPY_WORKSPACE_FILES_NAME, description=describe(
    'Batch duplicate existing workspace files to new workspace-relative destinations.',
    when='copying files without rewriting content.',
    not_='moving/renaming in place (use copy then delete) or directory trees.',
    shape=(
        f'each `copies` item needs `source_path` + `destination_path` ({RELATIVE_PATH}); '
        'sources must exist as files; parent dirs created; HITL confirm when auto-apply off.'
    ),
))
def copy_workspace_files(copies: list[CopyWorkspaceFileItem], overwrite: bool = False) -> str:

    session_id = current_session_id.get()
    blocked = mutation_tools_blocked_reason(session_id)
    if blocked:
        return blocked

    session = get_session(session_id)
    root = get_active_workspace_root()
    validated, detail = _validate_copy_batch(root, copies)
    if validated is None:
        return f'Tool error: {detail}'

    preview_pairs = detail
    if session.auto_apply_mode:
        ok, msg = _perform_copy(root, copies, overwrite)
        return msg if ok else f'Tool error: {msg}'

    session.pending_copy_request = {
        'request_id': uuid.uuid4().hex,
        'copies': [
            {'source_path': src.relative_to(root).as_posix(), 'destination_path': dest.relative_to(root).as_posix()}
            for src, dest in validated
        ],
        'overwrite': overwrite,
        'workspace_root': str(root.resolve()),
    }
    return (
        f'Pending user confirmation to copy {len(validated)} file(s)'
        f'{" with overwrite enabled" if overwrite else ""}: {_preview_pairs(preview_pairs)}. '
        'The UI will ask the user to confirm before any files are copied.'
    )
