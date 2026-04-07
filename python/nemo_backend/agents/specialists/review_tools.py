"""Tools for the nested code-review specialist (staging read/format/approve/reject)."""

from __future__ import annotations

import logging
from pathlib import Path

from langchain_core.tools import tool

from nemo_backend import edit_staging
from nemo_backend.edit_tool import (
    APPROVE_STAGED_WORKSPACE_EDIT_NAME,
    finalize_staged_edit,
)
from nemo_backend.state import current_session_id, get_session, runtime_config
from nemo_backend.workspace_text_io import DiskNewline
from nemo_backend.workspace_tools import truncate_text

logger = logging.getLogger('nemo.staging')

REJECT_STAGED_WORKSPACE_EDIT_NAME = 'reject_staged_workspace_edit'
READ_STAGED_EDIT_NAME = 'read_staged_edit'
FORMAT_STAGING_FILE_BLACK_NAME = 'format_staging_file_black'


def _max_staged_read_chars() -> int:
    v = runtime_config.tools.max_file_read_lines
    line_cap = max(50, min(int(v), 2000))
    return min(line_cap * 240, 480_000)


def _get_staging_entry(rel: str):
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    rel_key = rel.strip().replace('\\', '/')
    entry = session.pending_edit_stagings.get(rel_key)
    if not entry:
        return f'Tool error: no staged edit for `{rel_key}`.'
    return session, rel_key


@tool(READ_STAGED_EDIT_NAME)
def read_staged_edit(relative_path: str) -> str:
    """Read the current staged merged content for a workspace-relative path (nested planning staging dir).

    Use this to review drafts before approving; the workspace file may still reflect the pre-edit version."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    entry = session.pending_edit_stagings[rel_key]
    path = Path(entry.temp_path)
    try:
        text = edit_staging.read_staging_text(path, entry.disk_encoding)
    except OSError as exc:
        return f'Tool error: could not read staging file ({exc}).'
    cap = _max_staged_read_chars()
    body = truncate_text(text, cap)
    logger.info('read_staged_edit path=%s chars=%s truncated=%s', rel_key, len(text), len(text) > cap)
    return f'Staged file: `{rel_key}` ({len(text)} character(s))\n\n{body}'


@tool(FORMAT_STAGING_FILE_BLACK_NAME)
def format_staging_file_black(relative_path: str) -> str:
    """Run Black on the staged file for this path (Python only). Updates staged content on disk."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    if not rel_key.lower().endswith('.py'):
        return 'Tool error: Black applies only to `.py` staged files.'
    entry = session.pending_edit_stagings[rel_key]
    path = Path(entry.temp_path)
    nl: DiskNewline = 'crlf' if entry.disk_newline == 'crlf' else 'lf'
    ok, detail = edit_staging.run_black_on_file(path, encoding=entry.disk_encoding, disk_newline=nl)
    if not ok:
        logger.warning('format_staging_file_black failed path=%s detail=%s', rel_key, detail)
        return f'Black did not change the file (or failed): {detail}'
    try:
        entry.merged_text = edit_staging.read_staging_text(path, entry.disk_encoding)
    except OSError as exc:
        return f'Tool error: could not read staging after Black ({exc}).'
    logger.info('format_staging_file_black ok path=%s', rel_key)
    return f'Black formatted staged `{rel_key}`. You may re-read with `read_staged_edit` before approving.'


@tool(APPROVE_STAGED_WORKSPACE_EDIT_NAME)
def approve_staged_workspace_edit(relative_path: str) -> str:
    """Finalize a staged edit: propose diff (or auto-apply), then remove the staging temp file."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    entry = session.pending_edit_stagings.get(rel_key)
    if not entry:
        return f'Tool error: no staged edit for `{rel_key}`.'
    path = Path(entry.temp_path)
    out = finalize_staged_edit(session, rel_key, entry)
    if out.startswith('Tool error:'):
        return out
    session.pending_edit_stagings.pop(rel_key, None)
    edit_staging.unlink_staging_quiet(path)
    logger.info('approve_staged_workspace_edit path=%s', rel_key)
    return out


@tool(REJECT_STAGED_WORKSPACE_EDIT_NAME)
def reject_staged_workspace_edit(relative_path: str, feedback: str) -> str:
    """Discard staging for this path and return feedback for the create/update specialist to revise."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    entry = session.pending_edit_stagings.pop(rel_key)
    edit_staging.unlink_staging_quiet(Path(entry.temp_path))
    fb = (feedback or '').strip() or '(no details)'
    logger.info('reject_staged_workspace_edit path=%s', rel_key)
    return (
        f'Rejected staged edit for `{rel_key}`. Return this to the router so it can hand off to the create/update '
        f'specialist again.\n\nReviewer feedback:\n{fb}'
    )


def code_review_specialist_tools() -> tuple[list[object], dict[str, object]]:
    from nemo_backend.workspace_tools import list_workspace_directory, read_workspace_file, search_workspace

    tools: list[object] = [
        read_workspace_file,
        search_workspace,
        list_workspace_directory,
        read_staged_edit,
        format_staging_file_black,
        approve_staged_workspace_edit,
        reject_staged_workspace_edit,
    ]
    m = {t.name: t for t in tools}
    return tools, m
