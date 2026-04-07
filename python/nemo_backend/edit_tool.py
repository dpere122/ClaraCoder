"""LangChain tools: propose workspace edits via separate full-file, line-range, and optional snippet tools.

When the session's :attr:`~nemo_backend.domain.SessionState.auto_apply_mode` is true, successful proposals are written
immediately under the workspace root and no ``pending_diff_payload`` is stored.

**Future edit-capable tools:** must respect Editor mode (``apply_mode`` when binding tools), ``SessionState.auto_apply_mode``,
and the diff / pause contract in :mod:`nemo_backend.agent` (see :func:`nemo_backend.tool_registry.hitl_diff_pause_tools`).
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.tools import tool

from nemo_backend.diff_payload import build_file_diff_payload
from nemo_backend.domain import EditStagingEntry, SessionState
from nemo_backend.partial_workspace_edit import merge_partial_edit
from nemo_backend.state import current_session_id, get_session, mutation_tools_blocked_reason, runtime_config
from nemo_backend.workspace_text_io import (
    DiskNewline,
    NewlineMode,
    decode_for_tools,
    parse_newline_mode,
    resolve_newline_for_write,
    validate_workspace_encoding,
    write_file_resolved,
)
from nemo_backend.workspace_tools import get_active_workspace_root, normalize_relative_path

logger = logging.getLogger('nemo.tools.edit')

__all__ = [
    'apply_workspace_full_file',
    'replace_workspace_line_range',
    'replace_workspace_snippet',
    'edit_tools_for_strict',
    'finalize_staged_edit',
    'APPROVE_STAGED_WORKSPACE_EDIT_NAME',
]


def _tool_encoding_param(encoding: str) -> str:
    raw = (encoding or '').strip()
    if not raw:
        raw = (runtime_config.tools.default_workspace_encoding or 'utf-8').strip()
    return validate_workspace_encoding(raw)


def _tool_newline_param(newline: str) -> NewlineMode:
    raw = (newline or '').strip()
    if not raw:
        raw = (runtime_config.tools.default_workspace_newline or 'lf').strip()
    return parse_newline_mode(raw)


def _finalize_workspace_edit(
    session: SessionState,
    rel_display: str,
    old_text: str,
    merged: str,
    mode: str,
    disk_encoding: str,
    disk_newline: DiskNewline,
) -> str:
    payload, err = build_file_diff_payload(
        rel_display,
        old_text,
        merged,
        disk_encoding=disk_encoding,
        disk_newline=disk_newline,
    )
    if err:
        return f'Tool error: {err}'

    if session.auto_apply_mode:
        try:
            root = get_active_workspace_root()
            target = normalize_relative_path(root, rel_display)
            write_file_resolved(target, merged, disk_encoding, disk_newline)
        except UnicodeEncodeError as uexc:
            logger.warning('auto-apply encode failed path=%s err=%s', rel_display, uexc)
            session.pending_diff_payload = None
            return (
                f'Tool error: content cannot be encoded as {disk_encoding!r} ({uexc}). '
                'Adjust characters or choose another encoding.'
            )
        except Exception as wexc:
            logger.warning('auto-apply write failed path=%s err=%s', rel_display, wexc)
            session.pending_diff_payload = None
            return f'Tool error: auto-apply failed: {wexc}'
        session.pending_diff_payload = None
        n_rows = len(payload['rows'])
        trunc = payload.get('truncated')
        summary_bits = [
            f'Auto-applied {mode} edit for `{rel_display}` ({n_rows} diff row(s) in preview; file written on disk).'
        ]
        if trunc:
            summary_bits.append('Diff rows were truncated for display.')
        return ' '.join(summary_bits)

    session.pending_diff_payload = payload

    n_rows = len(payload['rows'])
    trunc = payload.get('truncated')

    summary_bits = [f'Proposed {mode} edit for `{rel_display}`: {n_rows} diff row(s).']
    if trunc:
        summary_bits.append('Diff rows were truncated for display; content in the viewer may be partial.')
    summary_bits.append('The user can review the diff in the chat and apply it (e.g. Accept change / Apply entire file).')
    return ' '.join(summary_bits)


APPROVE_STAGED_WORKSPACE_EDIT_NAME = 'approve_staged_workspace_edit'


def finalize_staged_edit(session: SessionState, rel_display: str, entry: EditStagingEntry) -> str:
    """Apply a staged merged file through the normal diff/auto-apply path (used by code review approve tool)."""
    nl: DiskNewline = 'crlf' if entry.disk_newline == 'crlf' else 'lf'
    return _finalize_workspace_edit(
        session,
        rel_display,
        entry.old_text,
        entry.merged_text,
        entry.edit_mode,
        entry.disk_encoding,
        nl,
    )


def _after_merge_workspace_edit(
    session: SessionState,
    rel_display: str,
    old_text: str,
    merged: str,
    mode: str,
    disk_encoding: str,
    disk_newline: DiskNewline,
) -> str:
    """Finalize a workspace edit via diff or auto-apply (staging is handled by dedicated staging tools)."""
    return _finalize_workspace_edit(session, rel_display, old_text, merged, mode, disk_encoding, disk_newline)


def _edit_preamble(
    relative_path: str,
    *,
    disk_encoding: str,
    newline_mode: NewlineMode,
) -> tuple[SessionState, str, str, str, DiskNewline] | str:
    """Return (session, rel_display, old_text, disk_encoding, resolved_disk_newline) or error string."""
    session_id = current_session_id.get()
    if not session_id:
        return 'Tool error: no active session.'

    session = get_session(session_id)
    session.pending_diff_payload = None

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    rel_display = target.relative_to(root).as_posix()

    raw_existing: bytes | None = None
    old_text = ''
    if target.is_file():
        try:
            raw_existing = target.read_bytes()
            old_text = decode_for_tools(raw_existing, disk_encoding)
        except OSError as exc:
            return f'Tool error: could not read file ({exc}).'

    disk_nl = resolve_newline_for_write(newline_mode, path=target, raw_existing=raw_existing)

    return session, rel_display, old_text, disk_encoding, disk_nl


def _run_edit_tool(
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
    """Shared body for all three edit tools: validate params, read file, merge, finalize."""
    blocked = mutation_tools_blocked_reason()
    if blocked:
        return blocked
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

    return _after_merge_workspace_edit(session, rel_display, old_text, merged, mode, disk_enc, disk_nl)


@tool
def apply_workspace_full_file(
    relative_path: str,
    new_content: str,
    encoding: str = '',
    newline: str = '',
) -> str:
    """Replace the entire workspace file with `new_content`; opens a side-by-side diff in the UI.

    `encoding` is a text codec (default from app Settings → Tools): utf-8, utf-8-sig, utf-16, utf-16-le, utf-16-be,
    latin-1, cp1252, ascii, mac-roman.
    `newline` is `lf`, `crlf`, or `preserve` (match existing file line endings when the file exists; new files use LF).

    Use for new files or broad rewrites. For small localized changes, prefer `replace_workspace_line_range`.

    Relative paths only (e.g. src/app.ts). The user applies changes in the UI unless auto-apply is enabled."""

    return _run_edit_tool(
        relative_path, encoding, newline,
        mode='full-file',
        new_content=new_content or '',
    )


@tool
def replace_workspace_line_range(
    relative_path: str,
    start_line: int,
    end_line: int,
    new_snippet: str = '',
    encoding: str = '',
    newline: str = '',
) -> str:
    """Replace an inclusive block of lines (1-based, same numbering as `read_workspace_file`) with `new_snippet`.

    `new_snippet` may be empty to delete those lines. Prefer this for localized edits so the diff stays accurate.
    Use `apply_workspace_full_file` for new files or whole-file rewrites. `start_line=end_line=n+1` appends after
    the last line, and `1,1` can seed an empty file.
    See `apply_workspace_full_file` for `encoding` and `newline`.

    Relative paths only. The user applies changes in the UI unless auto-apply is enabled."""

    return _run_edit_tool(
        relative_path, encoding, newline,
        mode='line-range',
        new_snippet=new_snippet if new_snippet is not None else '',
        start_line=int(start_line) if start_line else 0,
        end_line=int(end_line) if end_line else 0,
    )


@tool
def replace_workspace_snippet(
    relative_path: str,
    old_snippet: str,
    new_snippet: str = '',
    encoding: str = '',
    newline: str = '',
) -> str:
    """Search-replace: find `old_snippet` once in the file and replace it with `new_snippet` (empty removes it).

    Include enough context that the match is unique. Do not paste line-number gutters from numbered `read_workspace_file`
    output (lines look like ``<n> │ ...`` or ``<n> | ...`` or legacy ``<n>: ...``) into `old_snippet`; use `read_workspace_file` with `include_line_numbers` false or use line-range replace.
    See `apply_workspace_full_file` for `encoding` and `newline`.
    Matching tries exact unique match, CRLF-normalized exact, then gated fuzzy locate.

    Relative paths only. The user applies changes in the UI unless auto-apply is enabled."""

    return _run_edit_tool(
        relative_path, encoding, newline,
        mode='snippet',
        old_snippet=old_snippet or '',
        new_snippet=new_snippet if new_snippet is not None else '',
    )


_BASE_EDIT_TOOLS: list[Any] = [
    apply_workspace_full_file,
    replace_workspace_line_range,
    replace_workspace_snippet,
]


def edit_tools_for_strict(edit_tools_strict: bool) -> list[Any]:
    """Return LangChain tools bound for the worker when Editor mode is on (snippet tool omitted when strict)."""
    return _BASE_EDIT_TOOLS[:2] if edit_tools_strict else list(_BASE_EDIT_TOOLS)
