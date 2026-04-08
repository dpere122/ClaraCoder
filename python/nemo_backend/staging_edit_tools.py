"""Dedicated staging tools for create/update specialists in the nested planning pipeline.

These tools always route through the staging path: code-review extensions are staged under
``NEMO_STAGING_DIR`` for review, while non-code files finalize immediately via diff/auto-apply.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from langchain_core.tools import tool

from nemo_backend import edit_staging as _edit_staging
from nemo_backend.domain import EditStagingEntry, SessionState
from nemo_backend.edit_tool import _finalize_workspace_edit, _tool_encoding_param, _tool_newline_param
from nemo_backend.lsp.file_policy import is_lsp_managed_path
from nemo_backend.lsp.manager import sync_session_document
from nemo_backend.partial_workspace_edit import merge_partial_edit
from nemo_backend.state import current_session_id, mutation_tools_blocked_reason
from nemo_backend.workspace_text_io import (
    DiskNewline,
    NewlineMode,
    decode_for_tools,
    resolve_newline_for_write,
    validate_workspace_encoding,
)
from nemo_backend.workspace_tools import get_active_workspace_root, normalize_relative_path

logger = logging.getLogger('nemo.staging')

STAGE_CREATE_FILE_NAME = 'stage_create_file'
STAGE_WORKSPACE_FILE_OVERWRITE_NAME = 'stage_workspace_file_overwrite'
STAGE_LINE_RANGE_EDIT_NAME = 'stage_line_range_edit'
STAGE_SNIPPET_EDIT_NAME = 'stage_snippet_edit'

__all__ = [
    'stage_create_file',
    'stage_workspace_file_overwrite',
    'stage_line_range_edit',
    'stage_snippet_edit',
    'STAGE_CREATE_FILE_NAME',
    'STAGE_WORKSPACE_FILE_OVERWRITE_NAME',
    'STAGE_LINE_RANGE_EDIT_NAME',
    'STAGE_SNIPPET_EDIT_NAME',
]


def _existing_staging_entry(session: SessionState, rel_display: str) -> EditStagingEntry | None:
    entry = session.pending_edit_stagings.get(rel_display)
    return entry if isinstance(entry, EditStagingEntry) else None


def _staging_edit_preamble(
    relative_path: str,
    *,
    disk_encoding: str,
    newline_mode: NewlineMode,
) -> tuple[SessionState, str, str, str, DiskNewline] | str:
    session_id = current_session_id.get()
    if not session_id:
        return 'Tool error: no active session.'

    from nemo_backend.state import get_session

    session = get_session(session_id)
    session.pending_diff_payload = None

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    rel_display = target.relative_to(root).as_posix()

    source_root = _edit_staging.get_active_planner_snapshot_root(session) or root
    source = normalize_relative_path(source_root, rel_display)
    if not source.exists() and target.exists():
        source = target

    raw_existing: bytes | None = None
    old_text = ''
    if source.is_file():
        try:
            raw_existing = source.read_bytes()
            old_text = decode_for_tools(raw_existing, disk_encoding)
        except OSError as exc:
            return f'Tool error: could not read file ({exc}).'

    disk_nl = resolve_newline_for_write(newline_mode, path=source, raw_existing=raw_existing)
    return session, rel_display, old_text, disk_encoding, disk_nl


def _staging_after_merge(
    session: SessionState,
    rel_display: str,
    original_old_text: str,
    merged: str,
    mode: str,
    disk_encoding: str,
    disk_newline: DiskNewline,
    *,
    staging_seed_text: str | None = None,
) -> str:
    """Write merged content to staging dir; stage code files for review, finalize non-code immediately."""
    session_id = current_session_id.get()
    if not session_id:
        return _finalize_workspace_edit(
            session,
            rel_display,
            original_old_text,
            merged,
            mode,
            disk_encoding,
            disk_newline,
        )

    had_prior_staging = rel_display in session.pending_edit_stagings
    prior = session.pending_edit_stagings.pop(rel_display, None)
    if prior:
        _edit_staging.unlink_staging_quiet(Path(prior.temp_path))

    temp_path = _edit_staging.allocate_staging_file(
        session_id,
        rel_display,
        graph_id=session.active_planner_graph_id,
    )
    try:
        if staging_seed_text is not None:
            _edit_staging.write_staging_text(temp_path, staging_seed_text, disk_encoding, disk_newline)
        _edit_staging.write_staging_text(temp_path, merged, disk_encoding, disk_newline)
    except OSError as exc:
        return f'Tool error: could not write staging file ({exc}).'

    if rel_display.lower().endswith('.py'):
        ok, detail = _edit_staging.run_black_on_file(temp_path, encoding=disk_encoding, disk_newline=disk_newline)
        logger.info('black path=%s ok=%s detail=%s', rel_display, ok, detail)
    try:
        merged_out = _edit_staging.read_staging_text(temp_path, disk_encoding)
    except OSError as exc:
        return f'Tool error: could not read staging file ({exc}).'
    _edit_staging.write_snapshot_file(session, rel_display, merged_out, disk_encoding, disk_newline)

    diagnostics_note = ''
    diagnostics: list[dict[str, object]] = []
    if is_lsp_managed_path(rel_display):
        try:
            diagnostics = sync_session_document(rel_display, merged_out, session_id=session_id, scope='staging')
            logger.info('python LSP sync path=%s diagnostics=%s', rel_display, len(diagnostics))
            diagnostics_note = f' Python LSP diagnostics: {len(diagnostics)} issue(s).'
        except Exception as exc:
            logger.warning('python LSP sync failed path=%s err=%s', rel_display, exc)
            diagnostics_note = f' Python LSP sync failed: {exc}.'

    if _edit_staging.is_code_review_extension(rel_display):
        session.pending_edit_stagings[rel_display] = EditStagingEntry(
            temp_path=str(temp_path),
            old_text=original_old_text,
            merged_text=merged_out,
            disk_encoding=disk_encoding,
            disk_newline=disk_newline,
            edit_mode=mode,
            workspace_applied=False,
        )
        logger.info('staged for code review path=%s', rel_display)
        action = 'Updated staged draft' if had_prior_staging else 'Staged'
        return (
            f'{action} `{rel_display}` for code review (nested planning). The workspace file is not updated yet. '
            f'Tell the router to call `route_code_review_specialist` with the path and task context before finishing.'
            f'{diagnostics_note}'
        )

    out = _finalize_workspace_edit(session, rel_display, original_old_text, merged_out, mode, disk_encoding, disk_newline)
    _edit_staging.unlink_staging_quiet(temp_path)
    return out + diagnostics_note


def _run_staging_tool(
    relative_path: str,
    encoding: str,
    newline: str,
    *,
    mode: str,
    new_content: str = '',
    old_snippet: str = '',
    new_snippet: str = '',
    start_line: int = 0,
    end_line: int = 0,
) -> str:
    """Shared body for staging tools: validate, read, merge, then stage or finalize."""
    blocked = mutation_tools_blocked_reason()
    if blocked:
        return blocked
    try:
        enc = _tool_encoding_param(encoding)
        nm = _tool_newline_param(newline)
    except ValueError as exc:
        return f'Tool error: {exc}'

    pre = _staging_edit_preamble(relative_path, disk_encoding=enc, newline_mode=nm)
    if isinstance(pre, str):
        return pre
    session, rel_display, workspace_old_text, disk_enc, disk_nl = pre
    prior = _existing_staging_entry(session, rel_display)
    base_text = workspace_old_text
    original_old_text = workspace_old_text
    if prior:
        try:
            base_text = _edit_staging.read_staging_text(Path(prior.temp_path), prior.disk_encoding)
        except OSError as exc:
            return f'Tool error: could not read existing staged draft ({exc}).'
        original_old_text = prior.old_text
        disk_enc = prior.disk_encoding
        disk_nl = 'crlf' if prior.disk_newline == 'crlf' else 'lf'

    merged, merge_err = merge_partial_edit(
        base_text,
        new_content=new_content,
        old_snippet=old_snippet,
        new_snippet=new_snippet,
        start_line=start_line,
        end_line=end_line,
    )
    if merge_err:
        return f'Tool error: {merge_err}'
    assert merged is not None

    return _staging_after_merge(
        session,
        rel_display,
        original_old_text,
        merged,
        mode,
        disk_enc,
        disk_nl,
        staging_seed_text=workspace_old_text,
    )


@tool(STAGE_CREATE_FILE_NAME)
def stage_create_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
) -> str:
    """Use for new files or full-file rewrites in the nested mutation pipeline; programming-language files are staged for code review before the workspace updates.

    Parent directories for the target path are created when the change is applied to the workspace (non-code files immediately; code files after review transfer).

    `encoding` is a text codec (default from app Settings): utf-8, utf-8-sig, utf-16, utf-16-le, utf-16-be,
    latin-1, cp1252, ascii, mac-roman.
    `newline` is `lf`, `crlf`, or `preserve` (match existing file endings; new files default to LF).

    Non-code files (e.g. config, markdown) are finalized immediately via diff or auto-apply.

    Relative paths only (e.g. src/app.ts)."""

    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='full-file',
        new_content=new_content or '',
    )


@tool(STAGE_WORKSPACE_FILE_OVERWRITE_NAME)
def stage_workspace_file_overwrite(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
) -> str:
    """Use when the file already exists in the workspace (or a staged draft exists) and you have the full revised contents.

    Copies the current workspace file into staging, then overwrites the staged file with `new_content`.
    If the target does not exist yet, use `stage_create_file` instead. Programming-language files are staged for
    code review before the workspace updates; non-code files are finalized immediately via diff or auto-apply.

    `encoding` is a text codec (default from app Settings): utf-8, utf-8-sig, utf-16, utf-16-le, utf-16-be,
    latin-1, cp1252, ascii, mac-roman.
    `newline` is `lf`, `crlf`, or `preserve` (match existing file endings).

    Relative paths only (e.g. src/app.ts)."""

    blocked = mutation_tools_blocked_reason()
    if blocked:
        return blocked
    try:
        enc = validate_workspace_encoding(_tool_encoding_param(encoding))
        nm = _tool_newline_param(newline)
    except ValueError as exc:
        return f'Tool error: {exc}'

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    pre = _staging_edit_preamble(relative_path, disk_encoding=enc, newline_mode=nm)
    if isinstance(pre, str):
        return pre
    session, rel_display, workspace_old_text, disk_enc, disk_nl = pre
    prior = _existing_staging_entry(session, rel_display)
    if not target.is_file() and prior is None:
        return (
            f'Tool error: `{target.relative_to(root).as_posix()}` does not exist in the workspace. '
            'Use `stage_create_file` for new files unless an existing staged draft for this path should be revised.'
        )
    if prior is not None:
        disk_enc = prior.disk_encoding
        disk_nl = 'crlf' if prior.disk_newline == 'crlf' else 'lf'
        original_old_text = prior.old_text
        staging_seed_text = prior.merged_text
    else:
        original_old_text = workspace_old_text
        staging_seed_text = workspace_old_text
    return _staging_after_merge(
        session,
        rel_display,
        original_old_text,
        new_content or '',
        'full-file',
        disk_enc,
        disk_nl,
        staging_seed_text=staging_seed_text,
    )


@tool(STAGE_LINE_RANGE_EDIT_NAME)
def stage_line_range_edit(
    relative_path: str,
    start_line: int,
    end_line: int,
    new_snippet: str = '',
    new_content: str = '',
    encoding: str = '',
    newline: str = '',
) -> str:
    """Replace an inclusive block of lines (1-based) with `new_snippet`; the result is staged for code review.

    Some models wrongly pass replacement text as `new_content`; if `new_snippet` is empty, that value is used instead.

    `new_snippet` may be empty to delete those lines. Prefer this for localized edits so the diff stays accurate.
    Use `stage_create_file` for new files or whole-file rewrites. `start_line=end_line=n+1` appends after the
    last line, and `1,1` can seed an empty file.
    See `stage_create_file` for `encoding` and `newline`.

    Programming-language files are staged for code review before the workspace updates.
    Non-code files are finalized immediately via diff or auto-apply.

    Relative paths only."""

    ns = '' if new_snippet is None else new_snippet
    nc = '' if new_content is None else new_content
    snippet = ns if ns != '' else nc
    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='line-range',
        new_snippet=snippet,
        start_line=int(start_line) if start_line else 0,
        end_line=int(end_line) if end_line else 0,
    )


@tool(STAGE_SNIPPET_EDIT_NAME)
def stage_snippet_edit(
    relative_path: str,
    old_snippet: str,
    new_snippet: str = '',
    encoding: str = '',
    newline: str = '',
) -> str:
    """Search-replace: find `old_snippet` once and replace with `new_snippet`; the result is staged for code review.

    Include enough context that the match is unique. Do not paste line-number gutters from `read_workspace_file`
    output into `old_snippet`; use line-range replace instead.
    See `stage_create_file` for `encoding` and `newline`.
    Matching tries exact unique match, CRLF-normalized exact, then gated fuzzy locate.

    Programming-language files are staged for code review before the workspace updates.
    Non-code files are finalized immediately via diff or auto-apply.

    Relative paths only."""

    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='snippet',
        old_snippet=old_snippet or '',
        new_snippet=new_snippet if new_snippet is not None else '',
    )


STAGING_TOOLS: list[Any] = [
    stage_create_file,
    stage_workspace_file_overwrite,
    stage_line_range_edit,
    stage_snippet_edit,
]
