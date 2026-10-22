"""Workspace edit tools. Every edit is written straight to disk.

There is no staging or landing step. The first mutation of each path in a turn is journaled (the pre-turn
bytes) via :mod:`clara_coder_backend.session.file_journal`. Electron keeps those rows per turn, so the user
reviews the turn's edited files after the reply and can reset any of them. Auto Run does not apply to edits.

Each write runs the in-memory formatter (Black / Prettier, when enabled in Settings → Tools), writes the file,
journals it, and syncs the language server. The result ends with the post-edit diagnostics footer.

Parallel tool calls run in a thread pool, so each edit holds its file's lock (see :mod:`.path_locks`) from read
to LSP sync, and edits of one file apply one after another. Snippet edits then build on each other. A line-range
edit of a file another call in the same response already changed is moved onto the shifted lines, and refused
only when that call changed the lines it targets. A whole-file rewrite of such a file is refused, since it would
discard that change.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.lsp.diagnostics import post_edit_checks_footer
from clara_coder_backend.lsp.file_policy import is_lsp_managed_path, is_prettier_managed_path, lsp_server_for_path
from clara_coder_backend.lsp.manager import sync_session_document
from clara_coder_backend.session.file_journal import emit_edit_journal
from clara_coder_backend.session.state import (
    agent_formatters_enabled,
    current_session_id,
    current_tool_call_id,
    get_session,
    mutation_tools_blocked_reason,
    runtime_config,
)
from clara_coder_backend.domain import SessionState
from clara_coder_backend.tools.edit_diffs import edit_unified_diff, record_edit_diff
from clara_coder_backend.tools.tool_conventions import ONE_BASED, RELATIVE_PATH, VERIFY_LSP, describe, tool_output_cap
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path
from clara_coder_backend.workspace.formatters import format_python_source_str, format_source_via_prettier
from clara_coder_backend.workspace.partial_edit import line_range_edit_tool_feedback, merge_partial_edit
from clara_coder_backend.workspace.path_locks import batch_line_map, locked_path, note_batch_write
from clara_coder_backend.workspace.workspace_text_io import (
    DiskNewline,
    NewlineMode,
    decode_for_tools,
    parse_newline_mode,
    resolve_newline_for_write,
    validate_workspace_encoding,
    write_file_resolved,
)

logger = logging.getLogger('clara.tools.edit')

WRITE_WORKSPACE_FILE_NAME = 'write_workspace_file'
REPLACE_WORKSPACE_LINES_NAME = 'replace_workspace_lines'
REPLACE_WORKSPACE_SNIPPET_NAME = 'replace_workspace_snippet'
FORMAT_WORKSPACE_FILE_NAME = 'format_workspace_file'

_DIAGNOSTICS_FOOTER_MAX_CHARS = 14_000

_ENCODING_HINT = 'empty = Settings default'
_NEWLINE_HINT = 'lf | crlf | preserve (match existing); empty = Settings default'

__all__ = [
    'FORMAT_WORKSPACE_FILE_NAME',
    'REPLACE_WORKSPACE_LINES_NAME',
    'REPLACE_WORKSPACE_SNIPPET_NAME',
    'WRITE_WORKSPACE_FILE_NAME',
    'edit_tools',
    'format_workspace_file',
    'replace_workspace_lines',
    'replace_workspace_snippet',
    'write_workspace_file',
    'write_workspace_text',
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


@dataclass
class _EditTarget:
    session: SessionState
    session_id: str
    rel: str
    path: Path
    old_text: str
    encoding: str
    newline: DiskNewline
    existed: bool
    path_key: str


@contextmanager
def _edit_target(relative_path: str, encoding: str, newline: str) -> Iterator[_EditTarget | str]:
    """Validate params, lock the file, and read it once; yields the target or a ``Tool error:`` string.

    Callers merge and write inside the ``with`` block, so a parallel edit of the same file reads only after
    this one has written.
    """
    blocked = mutation_tools_blocked_reason()
    if blocked:
        yield blocked
        return
    session_id = (current_session_id.get() or '').strip()
    try:
        enc = _tool_encoding_param(encoding)
        nm = _tool_newline_param(newline)
        root = get_active_workspace_root()
        path = normalize_relative_path(root, relative_path)
        rel = path.relative_to(root).as_posix()
    except ValueError as exc:
        yield f'Tool error: {exc}'
        return
    with locked_path(path) as key:
        yield _read_target(session_id, rel, path, enc, nm, key)


def _read_target(session_id: str, rel: str, path: Path, enc: str, nm: NewlineMode, key: str) -> _EditTarget | str:
    existed = path.is_file()
    raw: bytes | None = None
    old_text = ''
    if existed:
        try:
            raw = path.read_bytes()
            old_text = decode_for_tools(raw, enc)
        except OSError as exc:
            return f'Tool error: could not read `{rel}` ({exc}).'
        except UnicodeDecodeError as exc:
            return f'Tool error: `{rel}` is not valid {enc} ({exc}); pass the right `encoding`.'
    disk_nl = resolve_newline_for_write(nm, path=path, raw_existing=raw)
    return _EditTarget(get_session(session_id), session_id, rel, path, old_text, enc, disk_nl, existed, key)


def _format_in_memory(rel: str, text: str, encoding: str) -> tuple[str, str]:
    """Format with Black / Prettier when enabled. Returns ``(text, one-line formatter note)``."""
    if not agent_formatters_enabled():
        return text, ''
    if rel.lower().endswith('.py'):
        formatted, err = format_python_source_str(text)
        label = 'Black'
    elif is_prettier_managed_path(rel):
        formatted, err = format_source_via_prettier(
            text,
            workspace_root=get_active_workspace_root(),
            relative_posix=rel,
            source_encoding=encoding or 'utf-8',
        )
        label = 'Prettier'
    else:
        return text, ''
    if formatted is None:
        logger.info('%s skipped path=%s detail=%s', label, rel, err)
        return text, f'Formatter ({label}): skipped ({err}).'
    return formatted, f'Formatter ({label}): applied.'


def _lsp_footer(t: _EditTarget, text: str, formatter_note: str) -> str:
    formatter_lines = [formatter_note] if formatter_note else []
    srv = lsp_server_for_path(t.rel)
    if not (srv and is_lsp_managed_path(t.rel)):
        return ('\n---\nPost-edit checks:\n' + formatter_note) if formatter_note else ''
    try:
        diagnostics = sync_session_document(t.rel, text, session_id=t.session_id or None, scope='workspace')
    except Exception as exc:
        logger.warning('%s LSP sync failed path=%s err=%s', srv, t.rel, exc)
        return '\n---\nPost-edit checks:\n' + '\n'.join([*formatter_lines, f'LSP sync failed: {exc}.'])
    footer = post_edit_checks_footer(
        t.rel,
        diagnostics,
        lsp_scope='workspace',
        server_kind=srv,
        formatter_lines=formatter_lines,
    )
    return tool_output_cap(footer, _DIAGNOSTICS_FOOTER_MAX_CHARS)


def _write_through(t: _EditTarget, merged: str, mode: str) -> str:
    """Format, write, journal (first write of this path per turn), and LSP-sync one edit.

    The diff of what was written goes to the UI with the finished status (see :mod:`.edit_diffs`).
    """
    text, formatter_note = _format_in_memory(t.rel, merged, t.encoding)
    try:
        write_file_resolved(t.path, text, t.encoding, t.newline)
    except UnicodeEncodeError as exc:
        return f'Tool error: content cannot be encoded as {t.encoding!r} ({exc}). Adjust characters or `encoding`.'
    except OSError as exc:
        return f'Tool error: could not write `{t.rel}` ({exc}).'
    note_batch_write(t.path_key, t.old_text, text)
    emit_edit_journal(
        t.session,
        t.rel,
        t.old_text,
        before_existed=t.existed,
        encoding=t.encoding,
        newline=t.newline,
    )
    record_edit_diff(current_tool_call_id.get(), edit_unified_diff(t.rel, t.old_text, text, existed=t.existed))
    before_lines = t.old_text.count('\n') + (1 if t.old_text and not t.old_text.endswith('\n') else 0)
    after_lines = text.count('\n') + (1 if text and not text.endswith('\n') else 0)
    verb = 'Updated' if t.existed else 'Created'
    logger.info('edit written path=%s mode=%s', t.rel, mode)
    return f'{verb} `{t.rel}` ({mode}; {before_lines} → {after_lines} lines).' + _lsp_footer(t, text, formatter_note)


def _merge_error(t: _EditTarget, err: str) -> str:
    return (
        f'Tool error: {err} If an earlier edit this turn already changed `{t.rel}`, your anchors are stale: '
        're-read it with `read_workspace_file` and retry with the current text.'
    )


def _changed_in_batch_error(t: _EditTarget, consequence: str) -> str:
    return (
        f'Tool error: another tool call in this same response already changed `{t.rel}`, so {consequence}. '
        'Nothing was written. Re-read it with `read_workspace_file` and retry against the current text.'
    )


def write_workspace_text(relative_path: str, content: str, *, encoding: str = '', newline: str = '') -> str:
    """Internal (non-tool) whole-file write through the same journal/format/LSP path, e.g. for bootstraps."""
    with _edit_target(relative_path, encoding, newline) as t:
        if isinstance(t, str):
            return t
        if t.existed and batch_line_map(t.path_key) is not None:
            return _changed_in_batch_error(t, 'rewriting the whole file now would discard that change')
        return _write_through(t, content or '', 'full-file')


@tool(
    WRITE_WORKSPACE_FILE_NAME,
    description=describe(
        'Create a file or replace its whole content; written to disk immediately (parent folders created)',
        when='new files or whole-file rewrites',
        not_='small changes to an existing file (use `replace_workspace_lines` or `replace_workspace_snippet`)',
        shape=(
            'before rewriting an existing file, read it whole with `read_workspace_file` (no line range) so '
            'headers and imports survive'
        ),
        verify=VERIFY_LSP,
    ),
)
def write_workspace_file(
    relative_path: Annotated[str, RELATIVE_PATH],
    content: Annotated[str, 'full new file text'],
    encoding: Annotated[str, _ENCODING_HINT] = '',
    newline: Annotated[str, _NEWLINE_HINT] = '',
) -> str:
    return write_workspace_text(relative_path, content, encoding=encoding, newline=newline)


@tool(
    REPLACE_WORKSPACE_LINES_NAME,
    description=describe(
        'Replace an inclusive line range of an existing file with `new_content`; written to disk immediately',
        when='localized edits when you know line numbers from a `read_workspace_file` gutter',
        not_='new files (use `write_workspace_file`); unique text anchors (use `replace_workspace_snippet`)',
        shape=(
            f'{ONE_BASED}; empty `new_content` deletes the lines; `start_line=end_line=n+1` appends after the '
            'last line. Line numbers shift after each edit, so re-read before an edit in a later response; '
            'parallel calls in one response may all use line numbers from the same read if their ranges do not '
            'overlap'
        ),
        verify=VERIFY_LSP,
    ),
)
def replace_workspace_lines(
    relative_path: Annotated[str, RELATIVE_PATH],
    start_line: Annotated[int, ONE_BASED],
    end_line: Annotated[int, ONE_BASED],
    new_content: Annotated[str, 'replacement lines; empty deletes'] = '',
    encoding: Annotated[str, _ENCODING_HINT] = '',
    newline: Annotated[str, _NEWLINE_HINT] = '',
) -> str:
    start, end = int(start_line or 0), int(end_line or 0)
    if start < 1 or end < start:
        return 'Tool error: need 1 <= start_line <= end_line.'
    with _edit_target(relative_path, encoding, newline) as t:
        if isinstance(t, str):
            return t
        moved_note = ''
        line_map = batch_line_map(t.path_key)
        if line_map is not None:
            moved = line_map.map_range(start, end)
            if moved is None:
                return _changed_in_batch_error(
                    t, f'lines {start}–{end} as you read them were changed already (or are past its end)'
                )
            if moved != (start, end):
                moved_note = (
                    f'\nAn earlier edit in this response shifted the file, so lines {start}–{end} were applied at '
                    f'{moved[0]}–{moved[1]}.'
                )
                start, end = moved
        merged, err = merge_partial_edit(
            t.old_text,
            new_content='',
            old_snippet='',
            new_snippet=new_content or '',
            start_line=start,
            end_line=end,
        )
        if err or merged is None:
            return _merge_error(t, err or 'line-range merge failed.')
        return (
            _write_through(t, merged, 'line-range')
            + moved_note
            + line_range_edit_tool_feedback(t.old_text, start, end, new_content or '')
        )


@tool(
    REPLACE_WORKSPACE_SNIPPET_NAME,
    description=describe(
        'Replace one unique `old_snippet` in an existing file with `new_snippet`; written to disk immediately',
        when='you have exact raw context (read with `include_line_numbers=false`)',
        not_='pasting numbered gutters into `old_snippet`; known line numbers (use `replace_workspace_lines`)',
        shape=(
            'match must be unique (exact, then CRLF/trailing-space tolerant, then gated fuzzy); include enough '
            'context; empty `new_snippet` removes the match'
        ),
        verify=VERIFY_LSP,
    ),
)
def replace_workspace_snippet(
    relative_path: Annotated[str, RELATIVE_PATH],
    old_snippet: Annotated[str, 'unique raw anchor text; no line-number gutters'],
    new_snippet: Annotated[str, 'replacement text; empty removes the match'] = '',
    encoding: Annotated[str, _ENCODING_HINT] = '',
    newline: Annotated[str, _NEWLINE_HINT] = '',
) -> str:
    with _edit_target(relative_path, encoding, newline) as t:
        if isinstance(t, str):
            return t
        if not t.existed:
            return f'Tool error: `{t.rel}` does not exist; create it with `write_workspace_file`.'
        if not old_snippet:
            return 'Tool error: `old_snippet` is required.'
        merged, err = merge_partial_edit(
            t.old_text,
            new_content='',
            old_snippet=old_snippet,
            new_snippet=new_snippet or '',
            start_line=0,
            end_line=0,
        )
        if err or merged is None:
            return _merge_error(t, err or 'snippet merge failed.')
        return _write_through(t, merged, 'snippet')


@tool(
    FORMAT_WORKSPACE_FILE_NAME,
    description=describe(
        'Format a file in place with Black (`.py`) or Prettier (web sources); edit tools already format what they write',
        when='a file you did not just edit needs formatting',
        not_='files you just wrote with an edit tool (already formatted)',
    ),
)
def format_workspace_file(relative_path: Annotated[str, RELATIVE_PATH]) -> str:
    with _edit_target(relative_path, '', 'preserve') as t:
        if isinstance(t, str):
            return t
        if not t.existed:
            return f'Tool error: `{t.rel}` does not exist.'
        text, note = _format_in_memory(t.rel, t.old_text, t.encoding)
        if not note:
            return f'Tool error: no formatter applies to `{t.rel}` (Black: `.py`; Prettier: web sources).'
        if text == t.old_text:
            return f'`{t.rel}` is already formatted. {note}'
        return _write_through(t, text, 'format')


_EDIT_TOOLS: list[Any] = [write_workspace_file, replace_workspace_lines, replace_workspace_snippet]


def edit_tools(*, strict: bool) -> list[Any]:
    """Edit tools for an Editor-mode agent: snippet replace is omitted when ``strict``; format when formatters on."""
    tools = list(_EDIT_TOOLS[:2] if strict else _EDIT_TOOLS)
    if agent_formatters_enabled():
        tools.append(format_workspace_file)
    return tools
