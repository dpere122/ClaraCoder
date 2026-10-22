"""LangChain tool: copy one or more workspace files (journaled per turn so the user can reset them)."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from clara_coder_backend.session.file_journal import emit_copy_journal, snapshot_text_file
from clara_coder_backend.session.state import current_session_id, get_session, mutation_tools_blocked_reason
from clara_coder_backend.tools.tool_conventions import RELATIVE_PATH, describe
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path
from clara_coder_backend.workspace.path_locks import locked_path, note_batch_replaced

logger = logging.getLogger('clara.tools.copy')

COPY_WORKSPACE_FILES_NAME = 'copy_workspace_files'

__all__ = [
    'COPY_WORKSPACE_FILES_NAME',
    'CopyWorkspaceFileItem',
    'copy_workspace_files',
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

    session = None
    sid = current_session_id.get()
    if sid:
        try:
            session = get_session(sid)
        except Exception:
            session = None
    root_resolved = root.resolve()
    try:
        for src, dest in copy_pairs:
            rel_dest = dest.relative_to(root_resolved).as_posix()
            # Same lock as the edit tools, so a parallel edit of ``dest`` lands wholly before or after the copy.
            with locked_path(dest) as key:
                dest_existed = dest.exists()
                if dest_existed and not overwrite:
                    return False, f'Destination already exists: `{rel_dest}`. Pass `overwrite=true` to replace it.'
                snap = snapshot_text_file(dest) if dest_existed else None
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                note_batch_replaced(key)
                if session is not None:
                    emit_copy_journal(
                        session,
                        rel_dest,
                        before_content=snap['content'] if snap else None,
                        before_encoding=snap['encoding'] if snap else None,
                        before_newline=snap['newline'] if snap else None,
                    )
    except OSError as exc:
        logger.warning('copy failed err=%s', exc)
        return False, f'Copy failed: {exc}'

    summary = _preview_pairs(preview_pairs)
    if overwrite:
        return True, f'Copied {len(copy_pairs)} file(s) with overwrite enabled. {summary}'
    return True, f'Copied {len(copy_pairs)} file(s). {summary}'


@tool(COPY_WORKSPACE_FILES_NAME, description=describe(
    'Copy existing workspace files to new destinations; runs immediately',
    when='duplicating files without rewriting content',
    not_='directory trees; moves (copy, then `delete_workspace_entries`)',
    shape=(
        f'each `copies` item has `source_path` + `destination_path` ({RELATIVE_PATH}); parent folders created; '
        '`overwrite=true` to replace existing destinations'
    ),
))
def copy_workspace_files(copies: list[CopyWorkspaceFileItem], overwrite: bool = False) -> str:
    blocked = mutation_tools_blocked_reason(current_session_id.get())
    if blocked:
        return blocked
    ok, msg = _perform_copy(get_active_workspace_root(), copies, overwrite)
    return msg if ok else f'Tool error: {msg}'
