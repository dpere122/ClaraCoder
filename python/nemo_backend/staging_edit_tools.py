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
from nemo_backend.edit_tool import _edit_preamble, _finalize_workspace_edit, _tool_encoding_param, _tool_newline_param
from nemo_backend.partial_workspace_edit import merge_partial_edit
from nemo_backend.state import current_session_id
from nemo_backend.workspace_text_io import DiskNewline

logger = logging.getLogger('nemo.staging')

STAGE_CREATE_FILE_NAME = 'stage_create_file'
STAGE_LINE_RANGE_EDIT_NAME = 'stage_line_range_edit'
STAGE_SNIPPET_EDIT_NAME = 'stage_snippet_edit'

__all__ = [
    'stage_create_file',
    'stage_line_range_edit',
    'stage_snippet_edit',
    'STAGE_CREATE_FILE_NAME',
    'STAGE_LINE_RANGE_EDIT_NAME',
    'STAGE_SNIPPET_EDIT_NAME',
]


def _staging_after_merge(
    session: SessionState,
    rel_display: str,
    old_text: str,
    merged: str,
    mode: str,
    disk_encoding: str,
    disk_newline: DiskNewline,
) -> str:
    """Write merged content to staging dir; stage code files for review, finalize non-code immediately."""
    session_id = current_session_id.get()
    if not session_id:
        return _finalize_workspace_edit(session, rel_display, old_text, merged, mode, disk_encoding, disk_newline)

    prior = session.pending_edit_stagings.pop(rel_display, None)
    if prior:
        _edit_staging.unlink_staging_quiet(Path(prior.temp_path))

    temp_path = _edit_staging.allocate_staging_file(session_id, rel_display)
    try:
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

    if _edit_staging.is_code_review_extension(rel_display):
        session.pending_edit_stagings[rel_display] = EditStagingEntry(
            temp_path=str(temp_path),
            old_text=old_text,
            merged_text=merged_out,
            disk_encoding=disk_encoding,
            disk_newline=disk_newline,
            edit_mode=mode,
        )
        logger.info('staged for code review path=%s', rel_display)
        return (
            f'Staged `{rel_display}` for code review (nested planning). The workspace file is not updated yet. '
            'Tell the router to call `route_code_review_specialist` with the path and task context before finishing.'
        )

    out = _finalize_workspace_edit(session, rel_display, old_text, merged_out, mode, disk_encoding, disk_newline)
    _edit_staging.unlink_staging_quiet(temp_path)
    return out


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
    try:
        enc = _tool_encoding_param(encoding)
        nm = _tool_newline_param(newline)
    except ValueError as exc:
        return f'Tool error: {exc}'

    pre = _edit_preamble(relative_path, disk_encoding=enc, newline_mode=nm)
    if isinstance(pre, str):
        return pre
    session, rel_display, old_text, disk_enc, disk_nl = pre

    merged, merge_err = merge_partial_edit(
        old_text,
        new_content=new_content,
        old_snippet=old_snippet,
        new_snippet=new_snippet,
        start_line=start_line,
        end_line=end_line,
    )
    if merge_err:
        return f'Tool error: {merge_err}'
    assert merged is not None

    return _staging_after_merge(session, rel_display, old_text, merged, mode, disk_enc, disk_nl)


@tool(STAGE_CREATE_FILE_NAME)
def stage_create_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
) -> str:
    """Create a new workspace file or fully rewrite an existing one; the result is staged for code review.

    `encoding` is a text codec (default from app Settings): utf-8, utf-8-sig, utf-16, utf-16-le, utf-16-be,
    latin-1, cp1252, ascii, mac-roman.
    `newline` is `lf`, `crlf`, or `preserve` (match existing file endings; new files default to LF).

    Programming-language files are staged under a temp directory for code review before the workspace updates.
    Non-code files (e.g. config, markdown) are finalized immediately via diff or auto-apply.

    Relative paths only (e.g. src/app.ts)."""

    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='full-file',
        new_content=new_content or '',
    )


@tool(STAGE_LINE_RANGE_EDIT_NAME)
def stage_line_range_edit(
    relative_path: str,
    start_line: int,
    end_line: int,
    new_snippet: str = '',
    encoding: str = '',
    newline: str = '',
) -> str:
    """Replace an inclusive block of lines (1-based) with `new_snippet`; the result is staged for code review.

    `new_snippet` may be empty to delete those lines. Prefer this for localized edits so the diff stays accurate.
    See `stage_create_file` for `encoding` and `newline`.

    Programming-language files are staged for code review before the workspace updates.
    Non-code files are finalized immediately via diff or auto-apply.

    Relative paths only."""

    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='line-range',
        new_snippet=new_snippet if new_snippet is not None else '',
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
    stage_line_range_edit,
    stage_snippet_edit,
]
