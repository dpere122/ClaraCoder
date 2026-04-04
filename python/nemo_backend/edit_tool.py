"""LangChain tools: propose workspace edits via separate full-file, line-range, and optional snippet tools.

When the session's :attr:`~nemo_backend.domain.SessionState.auto_apply_mode` is true, successful proposals are written
immediately under the workspace root and no ``pending_diff_payload`` is stored.

**Future edit-capable tools:** must respect Editor mode (``apply_mode`` when binding tools), ``SessionState.auto_apply_mode``,
and the diff / pause contract in :mod:`nemo_backend.agent` (see :func:`nemo_backend.tool_registry.hitl_diff_pause_tools`).
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool

from nemo_backend.diff_payload import build_file_diff_payload
from nemo_backend.domain import SessionState
from nemo_backend.partial_workspace_edit import merge_partial_edit
from nemo_backend.state import current_session_id, get_session
from nemo_backend.workspace_tools import get_active_workspace_root, normalize_relative_path, write_workspace_file_utf8

__all__ = [
    'apply_workspace_full_file',
    'replace_workspace_line_range',
    'replace_workspace_snippet',
    'edit_tools_for_strict',
]


def _finalize_workspace_edit(session: SessionState, rel_display: str, old_text: str, merged: str, mode: str) -> str:
    payload, err = build_file_diff_payload(rel_display, old_text, merged)
    if err:
        return f'Tool error: {err}'

    if session.auto_apply_mode:
        try:
            write_workspace_file_utf8(rel_display, merged)
        except Exception as wexc:
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


def _edit_preamble(relative_path: str) -> tuple[str, str, str] | str:
    """Return (session, rel_display, old_text) or error string."""
    session_id = current_session_id.get()
    if not session_id:
        return 'Tool error: no active session.'

    session = get_session(session_id)
    session.pending_diff_payload = None

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    rel_display = target.relative_to(root).as_posix()

    old_text = ''
    if target.is_file():
        old_text = target.read_text(encoding='utf-8', errors='replace')

    return session, rel_display, old_text


@tool
def apply_workspace_full_file(relative_path: str, new_content: str) -> str:
    """Replace the entire UTF-8 workspace file with `new_content`; opens a side-by-side diff in the UI.

    Use for new files or broad rewrites. For small localized changes, prefer `replace_workspace_line_range`.

    Relative paths only (e.g. src/app.ts). The user applies changes in the UI unless auto-apply is enabled."""

    pre = _edit_preamble(relative_path)
    if isinstance(pre, str):
        return pre
    session, rel_display, old_text = pre

    merged, merge_err = merge_partial_edit(
        old_text,
        new_content=new_content or '',
        old_snippet='',
        new_snippet='',
        start_line=0,
        end_line=0,
    )
    if merge_err:
        return f'Tool error: {merge_err}'
    assert merged is not None

    return _finalize_workspace_edit(session, rel_display, old_text, merged, 'full-file')


@tool
def replace_workspace_line_range(
    relative_path: str,
    start_line: int,
    end_line: int,
    new_snippet: str = '',
) -> str:
    """Replace an inclusive block of lines (1-based, same numbering as `read_workspace_file`) with `new_snippet`.

    `new_snippet` may be empty to delete those lines. Prefer this for localized edits so the diff stays accurate.

    Relative paths only. The user applies changes in the UI unless auto-apply is enabled."""

    pre = _edit_preamble(relative_path)
    if isinstance(pre, str):
        return pre
    session, rel_display, old_text = pre

    merged, merge_err = merge_partial_edit(
        old_text,
        new_content='',
        old_snippet='',
        new_snippet=new_snippet if new_snippet is not None else '',
        start_line=int(start_line) if start_line else 0,
        end_line=int(end_line) if end_line else 0,
    )
    if merge_err:
        return f'Tool error: {merge_err}'
    assert merged is not None

    return _finalize_workspace_edit(session, rel_display, old_text, merged, 'line-range')


@tool
def replace_workspace_snippet(relative_path: str, old_snippet: str, new_snippet: str = '') -> str:
    """Search-replace: find `old_snippet` once in the file and replace it with `new_snippet` (empty removes it).

    Include enough context that the match is unique. Do not paste `N: ` prefixes from numbered `read_workspace_file`
    output into `old_snippet`; use `read_workspace_file` with `include_line_numbers` false or use line-range replace.
    Matching tries exact unique match, CRLF-normalized exact, then gated fuzzy locate.

    Relative paths only. The user applies changes in the UI unless auto-apply is enabled."""

    pre = _edit_preamble(relative_path)
    if isinstance(pre, str):
        return pre
    session, rel_display, old_text = pre

    merged, merge_err = merge_partial_edit(
        old_text,
        new_content='',
        old_snippet=old_snippet or '',
        new_snippet=new_snippet if new_snippet is not None else '',
        start_line=0,
        end_line=0,
    )
    if merge_err:
        return f'Tool error: {merge_err}'
    assert merged is not None

    return _finalize_workspace_edit(session, rel_display, old_text, merged, 'snippet')


_BASE_EDIT_TOOLS: list[Any] = [
    apply_workspace_full_file,
    replace_workspace_line_range,
    replace_workspace_snippet,
]


def edit_tools_for_strict(edit_tools_strict: bool) -> list[Any]:
    """Return LangChain tools bound for the worker when Editor mode is on (snippet tool omitted when strict)."""
    return _BASE_EDIT_TOOLS[:2] if edit_tools_strict else list(_BASE_EDIT_TOOLS)
