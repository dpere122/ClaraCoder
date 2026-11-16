"""``lsp_rename_symbol``: rename a symbol across the workspace through the file's language server.

The agent names the symbol by its text on a line (models don't count UTF-16 columns); the tool finds the column
and asks the server for ``textDocument/rename``. The server answers with a ``WorkspaceEdit``: text edits per file.
The client advertises no resource operations, so a server never asks to create, rename or delete files.

Every file in the answer is locked and read, and every edit is checked against that text, before anything is
written: a file that can't take its edits leaves the whole rename unwritten. A replaced span must still contain
the old name, which catches a server that answered from an unsaved editor buffer instead of the file on disk.
A file another call of the same response already wrote is refused too, since the server's positions may predate
that write. Files are then written as they are (no formatter: a rename shouldn't restyle a file), journaled for
the turn like every other edit, and synced back to the server, whose diagnostics end the result. When a write
fails part way, the files already written are put back, so a rename never leaves the code half-renamed.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.lsp.file_policy import lsp_server_for_path, normalize_relative_posix_path
from clara_coder_backend.lsp.manager import session_diagnostics_fresh, sync_session_document
from clara_coder_backend.lsp.registry import display_label_for_server
from clara_coder_backend.session.state import current_session_id, current_tool_call_id, mutation_tools_blocked_reason
from clara_coder_backend.tools.edit import EditTarget, commit_edit, locked_edit_targets
from clara_coder_backend.tools.edit_diffs import discard_edit_diff
from clara_coder_backend.tools.lsp_tools import (
    _LSP_EXTENSIONS,
    _agent_manager,
    _default_encoding,
    _format_lsp_tool_error,
)
from clara_coder_backend.tools.tool_conventions import (
    NO_CHANGE_PREFIX,
    RELATIVE_PATH,
    VERIFY_LSP,
    clip_line,
    describe,
    tool_output_cap,
)
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path
from clara_coder_backend.workspace.path_locks import batch_line_map, note_batch_write
from clara_coder_backend.workspace.workspace_text_io import read_file_for_tools, write_bytes_atomic

logger = logging.getLogger('clara.tools.lsp_rename')

LSP_RENAME_SYMBOL_NAME = 'lsp_rename_symbol'

__all__ = ['LSP_RENAME_SYMBOL_NAME', 'apply_lsp_text_edits', 'lsp_rename_symbol']

#: Error diagnostics listed after a rename; the rest are counted.
_ERROR_ROWS_SHOWN = 20
#: How long a rename waits for the server's workspace analysis to settle before asking it.
_ANALYSIS_WAIT_S = 60.0
#: One identifier: ``$`` (JS), ``#`` (JS private fields, Rust ``r#raw``) and ``'`` (Rust lifetimes) included. A
#: qualified name (``self.count``, ``Type::new``) would put the column on its first part and rename that.
_IDENTIFIER = re.compile(r"[\w$#']+")
#: A sigil a server may leave out of the span it replaces (``#count`` → ``count``, ``'a`` → ``a``, ``r#type``).
_NAME_SIGIL = re.compile(r"^(?:r#|[#'])")
#: Characters that open a string or a lifetime: a name right after one is usually not the code symbol.
_QUOTES = frozenset('\'"`')


class StaleEditError(ValueError):
    """An edit's span no longer holds the old name: the server answered for text that isn't on disk."""


def symbol_column(line_text: str, symbol: str) -> int | None:
    """1-based LSP column (UTF-16 code units) of ``symbol``'s first whole-word match on ``line_text``.

    A match right after a quote (``config['timeout'] = timeout``, Rust ``<'a>(a: &'a u8)``) is passed over for a
    later unquoted one, since the server can't rename a string and would rename a lifetime instead of a variable.
    """

    # ``$`` is part of identifiers in JS/TS; ``\w`` covers the rest, Unicode letters included.
    matches = list(re.finditer(rf'(?<![\w$]){re.escape(symbol)}(?![\w$])', line_text))
    if not matches:
        return None
    match = next((m for m in matches if line_text[m.start() - 1 : m.start()] not in _QUOTES), None)
    start = (match or matches[0]).start()
    return len(line_text[:start].encode('utf-16-le')) // 2 + 1


def _line_starts(text: str) -> list[int]:
    return [0, *(match.end() for match in re.finditer('\n', text))]


def _offset(text: str, starts: list[int], position: Any) -> int:
    """String index of an LSP ``Position`` (0-based line, UTF-16 ``character``) in ``\\n``-normalized ``text``."""

    if not isinstance(position, dict):
        raise ValueError('an edit has no valid position')
    line = int(position.get('line', -1))
    character = int(position.get('character', 0))
    if not 0 <= line < len(starts):
        raise ValueError(f'an edit points at line {line + 1}, past the end of the file')
    index = starts[line]
    line_end = starts[line + 1] - 1 if line + 1 < len(starts) else len(text)
    units = 0
    # A character past the end of the line means the end of the line (LSP spec).
    while index < line_end and units < character:
        units += 2 if ord(text[index]) > 0xFFFF else 1
        index += 1
    if units > character:
        raise ValueError(f'an edit on line {line + 1} starts inside a character')
    return index


def apply_lsp_text_edits(text: str, edits: list[dict[str, Any]], old_name: str) -> str:
    """Apply one file's LSP ``TextEdit`` list to ``text`` (``\\n``-normalized, as the edit tools read it).

    All ranges refer to the original text, so they're applied from the end. Raises :class:`StaleEditError` when a
    replaced span doesn't contain ``old_name`` (its sigil may be left out), and ``ValueError`` for bad or
    overlapping ranges.
    """

    bare_name = _NAME_SIGIL.sub('', old_name) or old_name
    starts = _line_starts(text)
    spans: list[tuple[int, int, str]] = []
    for edit in edits:
        rng = edit.get('range') if isinstance(edit, dict) else None
        if not isinstance(rng, dict):
            raise ValueError('an edit has no range')
        start = _offset(text, starts, rng.get('start'))
        end = _offset(text, starts, rng.get('end'))
        if end < start:
            raise ValueError('an edit range ends before it starts')
        replaced = text[start:end]
        if replaced and bare_name not in replaced:
            raise StaleEditError(f'expected `{old_name}` but found {clip_line(replaced, 80)!r}')
        spans.append((start, end, str(edit.get('newText') or '').replace('\r\n', '\n').replace('\r', '\n')))
    spans.sort(key=lambda span: (span[0], span[1]))
    for (_, prev_end, _), (next_start, _, _) in zip(spans, spans[1:]):
        if next_start < prev_end:
            raise ValueError('the server sent overlapping edits')
    for start, end, new_text in reversed(spans):
        text = text[:start] + new_text + text[end:]
    return text


def _workspace_edit_by_uri(raw: dict[str, Any]) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    """``uri → text edits`` from a ``WorkspaceEdit``, plus the kinds of any file operations in it.

    ``documentChanges`` wins over ``changes`` when a server sends both (LSP spec).
    """

    by_uri: dict[str, list[dict[str, Any]]] = {}
    operations: list[str] = []
    document_changes = raw.get('documentChanges')
    if isinstance(document_changes, list):
        for block in document_changes:
            if not isinstance(block, dict):
                continue
            if 'kind' in block:
                operations.append(str(block.get('kind')))
                continue
            document = block.get('textDocument')
            uri = str(document.get('uri') or '') if isinstance(document, dict) else ''
            edits = block.get('edits')
            if uri and isinstance(edits, list):
                by_uri.setdefault(uri, []).extend(e for e in edits if isinstance(e, dict))
        return by_uri, operations
    changes = raw.get('changes')
    if isinstance(changes, dict):
        for uri, edits in changes.items():
            if isinstance(edits, list):
                by_uri.setdefault(str(uri), []).extend(e for e in edits if isinstance(e, dict))
    return by_uri, operations


def _workspace_rel(root: Path, uri: str) -> str | None:
    from clara_coder_backend.lsp.manager import _uri_to_path  # local import keeps public API small

    try:
        return _uri_to_path(uri).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def _sync_written(server: str, written: list[tuple[EditTarget, str]], encoding: str) -> list[str]:
    """Sync the renamed files to the server; waits for diagnostics on the last one only. Returns warnings."""

    session_id = (current_session_id.get() or '').strip() or None
    same_server = [(t, text) for t, text in written if lsp_server_for_path(t.rel) == server]
    warnings: list[str] = []
    for index, (t, text) in enumerate(same_server):
        try:
            sync_session_document(
                t.rel,
                text,
                session_id=session_id,
                scope='workspace',
                # One wait covers them all: the server re-checks every changed file before it settles
                # (rust-analyzer's cargo check runs once, not once per file).
                wait_for_diagnostics=index == len(same_server) - 1,
                reconcile_disk=index == 0,
                encoding=encoding,
            )
        except Exception as exc:
            logger.warning('%s LSP sync after rename failed path=%s err=%s', server, t.rel, exc)
            warnings.append(f'LSP sync failed for `{t.rel}` ({exc}).')
    return warnings


def _diagnostics_summary(server: str, written: list[tuple[EditTarget, str]]) -> list[str]:
    manager = _agent_manager(server)
    session_id = (current_session_id.get() or '').strip() or None
    errors: list[dict[str, Any]] = []
    pending: list[str] = []
    for t, _text in written:
        if lsp_server_for_path(t.rel) != server:
            continue
        errors.extend(row for row in manager.get_diagnostics(t.rel) if row.get('severity_value') == 1)
        if not session_diagnostics_fresh(t.rel, session_id=session_id):
            pending.append(t.rel)
    if errors:
        lines = [f'Errors in the renamed files ({len(errors)}):']
        lines.extend(
            f"- `{row['relative_path']}` {row['line']}:{row['character']} {row['message']}"
            for row in errors[:_ERROR_ROWS_SHOWN]
        )
        if len(errors) > _ERROR_ROWS_SHOWN:
            lines.append(f'... {len(errors) - _ERROR_ROWS_SHOWN} more.')
    else:
        lines = ['No errors in the renamed files.']
    if pending:
        names = ', '.join(f'`{rel}`' for rel in pending)
        lines.append(
            f'Note: the server has not finished checking {names} yet; call `lsp_get_diagnostics` to confirm.'
        )
    return lines


def _decodes_strictly(t: EditTarget) -> bool:
    """Whether ``t``'s bytes decode in its encoding without replacement characters."""

    try:
        t.path.read_bytes().decode(t.encoding)
    except (OSError, UnicodeDecodeError):
        return False
    return True


def _commit_all(planned: list[tuple[EditTarget, str, int]]) -> str | None:
    """Write every planned file, or none: a failed write puts back the files written before it.

    Returns a ``Tool error:`` string when a write failed, else None. Call with every file's lock held.
    """

    written: list[tuple[EditTarget, str, bytes]] = []
    error: str | None = None
    for t, renamed, _count in planned:
        try:
            original = t.path.read_bytes()
        except OSError as exc:
            error = f'Tool error: could not read `{t.rel}` ({exc}).'
            break
        error = commit_edit(t, renamed, 'rename')
        if error:
            break
        written.append((t, renamed, original))
    if error is None:
        return None
    not_restored: list[str] = []
    for t, renamed, original in reversed(written):
        try:
            write_bytes_atomic(t.path, original)
        except OSError as exc:
            logger.warning('rename rollback failed path=%s err=%s', t.rel, exc)
            not_restored.append(t.rel)
            continue
        note_batch_write(t.path_key, renamed, t.old_text)
    if not_restored:
        names = ', '.join(f'`{rel}`' for rel in reversed(not_restored))
        return f'{error} The rename stopped there, and {names} could not be put back: re-read and fix them.'
    # Every write was undone, so the UI has no diff to show for this call.
    discard_edit_diff(current_tool_call_id.get() or '')
    return f'{error} Nothing was written: the files renamed before it were put back.'


def _rename_with_server(rel: str, server: str, line: int, old_name: str, new_name: str) -> str:
    encoding = _default_encoding()
    root = get_active_workspace_root()
    primary = normalize_relative_path(root, rel)
    source_text = read_file_for_tools(primary, encoding)
    source_lines = source_text.split('\n')
    if not 1 <= line <= len(source_lines):
        return f'Tool error: `{rel}` has {len(source_lines)} lines; line {line} is out of range.'
    column = symbol_column(source_lines[line - 1], old_name)
    if column is None:
        shown = clip_line(source_lines[line - 1].strip(), 200)
        return (
            f'Tool error: `{old_name}` is not a whole word on line {line} of `{rel}` ({shown!r}). '
            'Re-read the file and pass a line that contains the symbol.'
        )
    label = display_label_for_server(server)
    manager = _agent_manager(server)
    manager.sync_for_agent(rel, encoding=encoding)
    if not manager.has_provider('renameProvider'):
        return f'Tool error: the {label} language server does not support rename. Use the edit tools instead.'
    notes: list[str] = []
    # A cold server answers from what it has loaded so far (basedpyright: the open files, until its first
    # scan ends), and a rename that misses uses breaks the code. ``sync_for_agent`` already waited for a
    # server that reports readiness; waiting for its analysis to settle could mean a whole cargo check.
    if not manager.reports_readiness and not manager.wait_for_workspace_analysis(timeout_s=_ANALYSIS_WAIT_S):
        notes.append(
            f'Note: the {label} language server was still analyzing the workspace, so uses in files it had not '
            'loaded yet may be missing. Check with `lsp_find_references` or `search_workspace`.'
        )
    raw = manager.rename(rel, line, column, new_name)
    if not isinstance(raw, dict):
        return f'Tool error: the {label} language server found nothing to rename at `{rel}` {line}:{column}.'

    by_uri, operations = _workspace_edit_by_uri(raw)
    if operations:
        return (
            f'Tool error: the {label} language server also wants to {"/".join(sorted(set(operations)))} files, '
            'which this tool does not do. Nothing was written.'
        )
    by_rel: dict[str, list[dict[str, Any]]] = {}
    for uri, edits in by_uri.items():
        target = _workspace_rel(root, uri)
        if target is None:
            return (
                f'Tool error: the rename reaches outside the workspace ({uri}), e.g. into library code. '
                'Nothing was written.'
            )
        by_rel.setdefault(target, []).extend(edits)
    by_rel = {target: edits for target, edits in by_rel.items() if edits}
    if not by_rel:
        return f'Tool error: the {label} language server returned no edits for `{old_name}`.'

    with locked_edit_targets(sorted(by_rel), encoding) as targets:
        if isinstance(targets, str):
            return targets
        planned: list[tuple[EditTarget, str, int]] = []
        for t in targets:
            edits = by_rel.get(t.rel, [])
            if not t.existed:
                return f'Tool error: the rename edits `{t.rel}`, which is not on disk. Nothing was written.'
            if batch_line_map(t.path_key) is not None:
                # Parallel calls run in any order, so the server may have answered before that write.
                return (
                    f'Tool error: another tool call in this same response already changed `{t.rel}`, so the '
                    f"{label} language server's positions may be from before that change. Nothing was written. "
                    'Call `lsp_rename_symbol` again in your next response, on its own.'
                )
            if t.path == primary and t.old_text != source_text:
                return (
                    f'Tool error: `{t.rel}` changed while the {label} language server was renaming. Nothing was '
                    'written. Re-read it and retry.'
                )
            if '\ufffd' in t.old_text and not _decodes_strictly(t):
                # Read with replacement characters: writing it back would destroy those bytes.
                return (
                    f'Tool error: `{t.rel}` is not valid {t.encoding}, so renaming in it would corrupt it. Nothing '
                    'was written. Rename with the edit tools, passing its `encoding`.'
                )
            try:
                renamed = apply_lsp_text_edits(t.old_text, edits, old_name)
            except StaleEditError as exc:
                return (
                    f"Tool error: the {label} language server's text of `{t.rel}` does not match the file on disk "
                    f'({exc}); it may have unsaved changes in the editor. Nothing was written. Save or revert that '
                    'file and retry.'
                )
            except ValueError as exc:
                return f'Tool error: could not apply the rename to `{t.rel}` ({exc}). Nothing was written.'
            if renamed != t.old_text:
                planned.append((t, renamed, len(edits)))
        if not planned:
            return f'{NO_CHANGE_PREFIX} the rename left every file as it was.'

        error = _commit_all(planned)
        if error:
            return error
        written = [(t, renamed) for t, renamed, _count in planned]
        warnings = _sync_written(server, written, encoding)
        total = sum(count for _t, _renamed, count in planned)
        lines = [
            f'Renamed `{old_name}` → `{new_name}` with the {label} language server: {total} edit(s) in '
            f'{len(planned)} file(s), written to disk.',
            *(f'- `{t.rel}` ({count} edit(s))' for t, _renamed, count in planned),
            '---',
            *notes,
            *warnings,
            *_diagnostics_summary(server, written),
        ]
    return tool_output_cap('\n'.join(lines))


@tool(
    LSP_RENAME_SYMBOL_NAME,
    description=describe(
        'Rename a symbol everywhere it is used, through the language server; every changed file is written to '
        'disk immediately',
        when='renaming a function, method, class, type, variable or field, in one file or across files',
        not_='renaming files; text that is not code (comments, strings, docs: use the edit tools)',
        shape=(
            f'`line` is 1-based and must contain `symbol` as a whole word (its first match on that line outside '
            'quotes is used); '
            f'`symbol` and `new_name` are bare identifiers (`count`, not `self.count`); {_LSP_EXTENSIONS}; '
            'all files change or none do'
        ),
        verify=VERIFY_LSP,
    ),
)
def lsp_rename_symbol(
    relative_path: Annotated[str, RELATIVE_PATH],
    line: Annotated[int, '1-based line that contains the symbol'],
    symbol: Annotated[str, 'current name, exactly as written on that line'],
    new_name: Annotated[str, 'new name'],
) -> str:
    blocked = mutation_tools_blocked_reason()
    if blocked:
        return blocked
    rel = normalize_relative_posix_path(relative_path)
    old_name, target_name = (symbol or '').strip(), (new_name or '').strip()
    if not old_name or not target_name:
        return 'Tool error: `symbol` and `new_name` are both required.'
    for arg, value in (('symbol', old_name), ('new_name', target_name)):
        if not _IDENTIFIER.fullmatch(value):
            return (
                f'Tool error: `{arg}` must be one identifier, got `{value}`. Pass the bare name '
                '(`count`, not `self.count` or `Type::count`).'
            )
    if old_name == target_name:
        return f'{NO_CHANGE_PREFIX} `{old_name}` already has that name.'
    server = lsp_server_for_path(rel)
    if not server:
        return f'Tool error: rename needs a file with a language server ({_LSP_EXTENSIONS}). Got `{rel}`.'
    try:
        return _rename_with_server(rel, server, int(line), old_name, target_name)
    except Exception as exc:
        return _format_lsp_tool_error('rename', exc, relative_path=rel, server=server)
