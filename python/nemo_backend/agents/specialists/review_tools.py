"""Tools for the nested code-review specialist (staging read/format/transfer/reject)."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from langchain_core.tools import tool

from nemo_backend import edit_staging
from nemo_backend.edit_tool import (
    APPROVE_STAGED_WORKSPACE_EDIT_NAME,
    finalize_staged_edit,
)
from nemo_backend.state import current_session_id, get_session, mutation_tools_blocked_reason, runtime_config
from nemo_backend.workspace_text_io import DiskNewline
from nemo_backend.workspace_tools import truncate_text

logger = logging.getLogger('nemo.staging')

REJECT_STAGED_WORKSPACE_EDIT_NAME = 'reject_staged_workspace_edit'
LIST_STAGED_EDITS_NAME = 'list_staged_edits'
READ_STAGED_EDIT_NAME = 'read_staged_edit'
SEARCH_STAGED_EDITS_NAME = 'search_staged_edits'
FORMAT_STAGING_FILE_BLACK_NAME = 'format_staging_file_black'
TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME = 'transfer_staged_file_to_workspace'
_READ_FILE_GUTTER_SEP = ' │ '


def _max_staged_read_chars() -> int:
    v = runtime_config.tools.max_file_read_lines
    line_cap = max(50, min(int(v), 2000))
    return min(line_cap * 240, 480_000)


def _effective_max_file_read_lines() -> int:
    v = runtime_config.tools.max_file_read_lines
    return max(50, min(int(v), 2000))


def _effective_max_search_results() -> int:
    v = runtime_config.tools.max_search_results
    return max(1, min(int(v), 200))


def _format_read_excerpt_with_gutter(excerpt: list[str], line_start: int, line_end: int) -> str:
    if not excerpt:
        return ''
    gutter_w = max(3, len(str(line_end)))
    return '\n'.join(
        f'{index:>{gutter_w}}{_READ_FILE_GUTTER_SEP}{line}'
        for index, line in enumerate(excerpt, start=line_start)
    )


def _get_staging_entry(rel: str):
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)
    rel_key = rel.strip().replace('\\', '/')
    entry = session.pending_edit_stagings.get(rel_key)
    if not entry:
        return f'Tool error: no staged edit for `{rel_key}`.'
    return session, rel_key


@tool(LIST_STAGED_EDITS_NAME)
def list_staged_edits() -> str:
    """List workspace-relative paths currently staged for code review."""

    sid = current_session_id.get()
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)
    paths = sorted(session.pending_edit_stagings.keys())
    if not paths:
        return 'No staged edits are available.'
    return 'Staged edits:\n' + '\n'.join(paths)


@tool(READ_STAGED_EDIT_NAME)
def read_staged_edit(
    relative_path: str,
    start_line: int = 1,
    end_line: int = 220,
    include_line_numbers: bool = True,
) -> str:
    """Read staged merged content for a workspace-relative path.

    `start_line`/`end_line` are 1-based inclusive over the staged text. Set `include_line_numbers=false`
    when you need the exact staged text without the gutter."""

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
    safe_start = max(1, start_line)
    cap = _effective_max_file_read_lines()
    safe_end = max(safe_start, min(end_line, safe_start + cap - 1))
    lines = text.splitlines()
    excerpt = lines[safe_start - 1 : safe_end]
    if include_line_numbers:
        body = _format_read_excerpt_with_gutter(excerpt, safe_start, safe_end)
        header = (
            f'Staged file: {rel_key}\n'
            f'Encoding: {entry.disk_encoding}\n'
            f'Lines: {safe_start}-{safe_end}\n'
            'Format: padded line number, then " │ ", then verbatim staged file text.\n\n'
        )
    else:
        body = '\n'.join(excerpt) if excerpt else ''
        header = f'Staged file: {rel_key}\nEncoding: {entry.disk_encoding}\nLines: {safe_start}-{safe_end}\n\n'
    preview = header + (body if body else '[empty range]')
    capped = truncate_text(preview, _max_staged_read_chars())
    logger.info('read_staged_edit path=%s chars=%s truncated=%s', rel_key, len(preview), len(preview) > len(capped))
    return capped


@tool(SEARCH_STAGED_EDITS_NAME)
def search_staged_edits(query: str, relative_path: str = '', max_matches: int = 20) -> str:
    """Search staged files with a regex pattern and return matching lines from staging only."""

    sid = current_session_id.get()
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)
    try:
        pattern = re.compile(query, re.IGNORECASE)
    except re.error as exc:
        return f'Tool error: invalid regex: {exc}'

    rel_filter = (relative_path or '').strip().replace('\\', '/')
    limit = max(1, min(int(max_matches), _effective_max_search_results()))
    matches: list[str] = []

    entries = sorted(session.pending_edit_stagings.items())
    if rel_filter:
        entries = [(path, entry) for path, entry in entries if path == rel_filter]
        if not entries:
            return f'Tool error: no staged edit for `{rel_filter}`.'

    for rel_key, entry in entries:
        try:
            text = edit_staging.read_staging_text(Path(entry.temp_path), entry.disk_encoding)
        except OSError as exc:
            logger.warning('search_staged_edits read failed path=%s err=%s', rel_key, exc)
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                matches.append(f'[{rel_key} line {line_number}]{_READ_FILE_GUTTER_SEP}{line}')
                if len(matches) >= limit:
                    return '\n'.join(matches)

    if not matches:
        return 'No matches found in staged edits.'
    return '\n'.join(matches)


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
    return f'Black formatted staged `{rel_key}`. You may re-read with `read_staged_edit` before transferring.'


@tool(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME)
def transfer_staged_file_to_workspace(relative_path: str) -> str:
    """Transfer a staged file into the workspace diff/apply flow, then remove its staging temp file."""

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
    logger.info('transfer_staged_file_to_workspace path=%s', rel_key)
    return f'Transferred staged `{rel_key}` to the workspace apply flow. {out}'


@tool(APPROVE_STAGED_WORKSPACE_EDIT_NAME)
def approve_staged_workspace_edit(relative_path: str) -> str:
    """Backward-compatible alias for `transfer_staged_file_to_workspace`."""

    return transfer_staged_file_to_workspace.invoke({'relative_path': relative_path})


@tool(REJECT_STAGED_WORKSPACE_EDIT_NAME)
def reject_staged_workspace_edit(relative_path: str, feedback: str) -> str:
    """Keep the staged draft available and return feedback for the create/update specialist to revise."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    _session, rel_key = got
    fb = (feedback or '').strip() or '(no details)'
    logger.info('reject_staged_workspace_edit path=%s', rel_key)
    return (
        f'Rejected staged edit for `{rel_key}`. Return this to the router so it can hand off to the create/update '
        f'specialist again. Keep revising the existing staged draft; it will be cleaned up automatically when the '
        f'nested workspace chain finishes.\n\nReviewer feedback:\n{fb}'
    )


def code_review_specialist_tools() -> tuple[list[object], dict[str, object]]:
    tools: list[object] = [
        list_staged_edits,
        read_staged_edit,
        search_staged_edits,
        format_staging_file_black,
        transfer_staged_file_to_workspace,
        reject_staged_workspace_edit,
    ]
    m = {t.name: t for t in tools}
    return tools, m
