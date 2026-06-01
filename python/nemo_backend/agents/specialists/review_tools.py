"""Tools for the nested code-review specialist (staging read/format/transfer/reject)."""

from __future__ import annotations

import asyncio
import difflib
import logging
import os
import re
from pathlib import Path
from typing import Literal

from langchain_core.tools import tool

from nemo_backend import edit_staging
from nemo_backend.agents.specialists.project_review_tools import (
    _emit_project_review_chunk,
    _emit_project_review_tool_complete,
    _pump_subprocess_stream,
    _terminate_process,
)
from nemo_backend.config import NEMO_SUBPROCESS_TIMEOUT_SEC
from nemo_backend.subprocess_smoke import (
    SmokeOutputTracker,
    SmokeStopReason,
    argv_implies_watch_mode,
    wait_for_smoke_completion,
)
from nemo_backend.diff_payload import build_file_diff_payload
from nemo_backend.domain import PendingStagedTransferHitl, SessionState, WorkspaceTestMaterializationEntry
from nemo_backend.lsp.diagnostics import format_diagnostics_summary, indentation_followup_guidance
from nemo_backend.lsp.file_policy import is_lsp_managed_path, is_prettier_managed_path, lsp_server_for_path
from nemo_backend.lsp.manager import sync_session_document
from nemo_backend.lsp.tools import lsp_get_diagnostics
from nemo_backend.python_env import (
    ensure_session_python_workspace_env,
    session_workspace_subprocess_env,
    with_subprocess_color_env,
)
from nemo_backend.search_backend import SearchCandidate, run_grep_line_search
from nemo_backend.staging_test_overlay import (
    build_staging_test_overlay,
    parse_command_argv_json,
    remove_overlay_parent,
    resolve_overlay_cwd,
)
from nemo_backend.deferred_tool_hitl import maybe_await_hitl_for_deferred_tool
from nemo_backend.stream_tags import TOOL_OVERLAY_STREAM_TAG
from nemo_backend.state import (
    current_session_id,
    direct_workspace_edits_active,
    get_session,
    mutation_tools_blocked_reason,
    runtime_config,
)
from nemo_backend.workspace_text_io import DiskNewline, decode_for_tools, write_file_resolved
from nemo_backend.workspace_tools import get_active_workspace_root, normalize_relative_path, truncate_text, truncate_text_head_tail

logger = logging.getLogger('nemo.staging')

REJECT_STAGED_WORKSPACE_EDIT_NAME = 'reject_staged_workspace_edit'
LIST_STAGED_EDITS_NAME = 'list_staged_edits'
READ_STAGED_EDIT_NAME = 'read_staged_edit'
SEARCH_STAGED_EDITS_NAME = 'search_staged_edits'
FORMAT_STAGING_FILE_BLACK_NAME = 'format_staging_file_black'
FORMAT_STAGING_FILE_PRETTIER_NAME = 'format_staging_file_prettier'
FORMAT_WORKSPACE_FILE_BLACK_NAME = 'format_workspace_file_black'
FORMAT_WORKSPACE_FILE_PRETTIER_NAME = 'format_workspace_file_prettier'
TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME = 'transfer_staged_file_to_workspace'
DIFF_STAGED_EDIT_AGAINST_BASELINE_NAME = 'diff_staged_edit_against_baseline'
RUN_STAGING_OVERLAY_COMMAND_NAME = 'run_staging_overlay_command'
_OVERLAY_STREAM_TAG = TOOL_OVERLAY_STREAM_TAG
_OVERLAY_STREAM_LABEL = 'Staging overlay'
_SUBPROCESS_READ_SIZE = 65_536
_MAX_OVERLAY_OUTPUT_CHARS = 120_000
# Cap unified-diff lines so tool output stays model-friendly (git-style hunks).
_MAX_STAGED_UNIFIED_DIFF_LINES = 2500
_MAX_STAGED_DIFF_CHARS = 480_000
_READ_FILE_GUTTER_SEP = ' │ '
_POST_TRANSFER_BATCH_LSP_MAX_CHARS = 14_000


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


def _search_staged_edits_python(
    entries: list[tuple[str, object]],
    *,
    pattern: re.Pattern[str],
    limit: int,
) -> list[str]:
    matches: list[str] = []
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
                    return matches
    return matches


def _search_staged_edits_grep(
    entries: list[tuple[str, object]],
    *,
    query: str,
    limit: int,
) -> list[str] | None:
    candidates = [
        SearchCandidate(command_path=str(Path(entry.temp_path)), display_path=rel_key)
        for rel_key, entry in entries
    ]
    grep_matches = run_grep_line_search(query, candidates, max_matches=limit)
    if grep_matches is None:
        return None

    entry_by_rel_key = {rel_key: entry for rel_key, entry in entries}
    lines_cache: dict[str, list[str]] = {}
    rendered: list[str] = []
    for match in grep_matches:
        entry = entry_by_rel_key.get(match.display_path)
        if entry is None:
            continue
        try:
            file_lines = lines_cache.get(match.display_path)
            if file_lines is None:
                file_lines = edit_staging.read_staging_text(Path(entry.temp_path), entry.disk_encoding).splitlines()
                lines_cache[match.display_path] = file_lines
        except OSError as exc:
            logger.warning('search_staged_edits grep reread failed path=%s err=%s', match.display_path, exc)
            continue
        if 1 <= match.line_number <= len(file_lines):
            rendered.append(
                f'[{match.display_path} line {match.line_number}]{_READ_FILE_GUTTER_SEP}'
                f'{file_lines[match.line_number - 1]}'
            )
    return rendered


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
    if _entry_workspace_applied(entry):
        return (
            f'Tool error: staged `{rel_key}` is already approved in the workspace for this chain. '
            'It is no longer pending review. For follow-up edits, read the live file with `read_workspace_file` and '
            'then stage the next revision with `stage_workspace_file_overwrite` or the matching '
            '`lsp_update_python_file` / `lsp_update_typescript_file` / `lsp_update_gdscript_file`.'
        )
    return session, rel_key


def _entry_workspace_applied(entry: object) -> bool:
    value = getattr(entry, 'workspace_applied', False)
    return value if isinstance(value, bool) else False


def _review_pending_entries(session) -> list[tuple[str, object]]:
    return [
        (rel_key, entry)
        for rel_key, entry in sorted(session.pending_edit_stagings.items())
        if not _entry_workspace_applied(entry)
    ]


def _post_transfer_lsp_section(session: SessionState, *, session_id: str | None) -> str:
    """After ``workspace_applied`` is set for the path just transferred, either defer LSP or run one batch pass.

    LSP sync runs **once** when every entry in ``pending_edit_stagings`` is transferred, so cross-file checks
    see the full on-disk batch instead of refreshing after each individual transfer.
    """
    remaining = _review_pending_entries(session)
    if remaining:
        n = len(remaining)
        return (
            '\n\nNote: Workspace LSP refresh is deferred until every staged path in this chain is transferred '
            f'({n} path(s) still pending `transfer_staged_file_to_workspace`).'
        )
    if not session.pending_edit_stagings:
        return ''
    managed = [
        rel
        for rel in sorted(session.pending_edit_stagings.keys())
        if is_lsp_managed_path(rel) and lsp_server_for_path(rel)
    ]
    if not managed:
        return (
            '\n\nPost-transfer LSP: no LSP-managed file extensions in this transferred batch; '
            'nothing to refresh automatically.'
        )
    chunks: list[str] = [
        '\n\n---',
        'Post-transfer LSP (all staged paths in this chain are on disk; workspace scope; formatter not re-run):',
    ]
    sid = (session_id or '').strip() or None
    for rel_key in managed:
        entry = session.pending_edit_stagings.get(rel_key)
        if entry is None:
            continue
        srv = lsp_server_for_path(rel_key) or ''
        try:
            diagnostics = sync_session_document(
                rel_key,
                str(entry.merged_text),
                session_id=sid,
                scope='workspace',
            )
        except Exception as exc:
            logger.warning('workspace LSP batch sync failed path=%s err=%s', rel_key, exc)
            ls_label = lsp_server_for_path(rel_key) or 'lsp'
            chunks.append(f'\n{ls_label} LSP sync failed for `{rel_key}`: {exc}.')
            continue
        chunks.append(
            '\n'
            + format_diagnostics_summary(
                rel_key,
                diagnostics,
                lsp_scope='workspace',
                analyzed_source='workspace after batch transfer',
                server_kind=srv,
            )
        )
        steer = indentation_followup_guidance(rel_key, diagnostics, lsp_scope='workspace').strip()
        if steer:
            chunks.append('\n' + steer)
    body = ''.join(chunks)
    return truncate_text_head_tail(body, _POST_TRANSFER_BATCH_LSP_MAX_CHARS)


def _unified_diff_baseline_vs_draft(rel_key: str, old_text: str, merged_text: str) -> tuple[str, bool]:
    """Return (formatted diff body, truncated)."""
    if '\x00' in old_text or '\x00' in merged_text:
        return 'Tool error: refusing diff — content appears binary (NUL bytes).', False
    a_lines = old_text.splitlines(keepends=True)
    b_lines = merged_text.splitlines(keepends=True)
    diff_lines = list(
        difflib.unified_diff(
            a_lines,
            b_lines,
            fromfile=f'workspace_baseline/{rel_key}',
            tofile=f'staged_draft/{rel_key}',
            lineterm='',
        )
    )
    truncated = len(diff_lines) > _MAX_STAGED_UNIFIED_DIFF_LINES
    if truncated:
        diff_lines = diff_lines[:_MAX_STAGED_UNIFIED_DIFF_LINES]
    body = '\n'.join(diff_lines)
    if body:
        body += '\n'
    return body, truncated


def _python_overlay_paths(session) -> list[tuple[str, object]]:
    return [(rel_key, entry) for rel_key, entry in _review_pending_entries(session) if rel_key.lower().endswith('.py')]


def _project_python_overlay_paths(
    session,
    *,
    project_prefix: str,
) -> list[tuple[str, object]]:
    entries = _python_overlay_paths(session)
    if not project_prefix:
        return [(rel_key, entry) for rel_key, entry in entries if rel_key.lower().endswith('.py')]
    return [
        (rel_key, entry)
        for rel_key, entry in entries
        if rel_key.startswith(project_prefix) and rel_key.lower().endswith('.py')
    ]


def _restore_materialized_path(session, rel_key: str) -> None:
    materialized = session.test_run_materializations.get(rel_key)
    if materialized is None:
        return
    root = Path(session.workspace_path).resolve()
    target = (root / rel_key).resolve()
    if materialized.existed:
        write_file_resolved(
            target,
            materialized.original_text,
            materialized.disk_encoding,
            'crlf' if materialized.disk_newline == 'crlf' else 'lf',
        )
    else:
        target.unlink(missing_ok=True)
    session.test_run_materializations.pop(rel_key, None)


def rollback_test_run_materializations(session) -> None:
    """Restore any workspace files that were materialized for test runs but not approved."""

    for rel_key in list(session.test_run_materializations.keys()):
        try:
            _restore_materialized_path(session, rel_key)
        except Exception as exc:
            logger.warning('rollback_test_run_materializations failed path=%s err=%s', rel_key, exc)


def _mark_materialization_approved(session, rel_key: str) -> None:
    session.test_run_materializations.pop(rel_key, None)


def finalize_staged_transfer_after_hitl(
    session,
    action: Literal['confirm', 're_review'],
    user_note: str,
    *,
    session_id: str | None = None,
) -> str:
    """Apply or abandon a deferred ``transfer_staged_file_to_workspace`` after chat HITL (``agent-continue``).

    ``session_id`` should be the chat session id when called from HTTP (``current_session_id`` is unset there).
    Returns text to append as a HumanMessage for the resumed agent (empty when nothing was pending).
    """
    pending = session.pending_staged_transfer_hitl
    if pending is None:
        return ''
    rel_key = pending.relative_path.strip().replace('\\', '/')
    session.pending_staged_transfer_hitl = None
    entry = session.pending_edit_stagings.get(rel_key)

    if action == 're_review':
        fb = (user_note or '').strip() or '(no details)'
        return (
            '**Staged transfer returned for re-review (user did not approve landing this draft in the workspace '
            f'yet).** Path: `{rel_key}`.\n\n'
            'Route back to the **code review** specialist (or file-write specialist as appropriate). Use '
            '`diff_staged_edit_against_baseline` / `read_staged_edit`, revise the staged draft, then call '
            '`transfer_staged_file_to_workspace` again when ready.\n\n'
            f'User / reviewer feedback:\n{fb}'
        )

    if entry is None:
        return f'User confirmed staged transfer for `{rel_key}`, but no staging entry remained (ignored).'
    if _entry_workspace_applied(entry):
        return f'User confirmed staged transfer for `{rel_key}` (already applied for this chain).'

    if rel_key in session.test_run_materializations:
        _mark_materialization_approved(session, rel_key)
        entry.old_text = str(entry.merged_text)
        entry.workspace_applied = True
        logger.info('finalize_staged_transfer_after_hitl confirm test_run path=%s', rel_key)
        lsp_sid = (session_id or current_session_id.get() or '').strip() or None
        lsp_section = _post_transfer_lsp_section(session, session_id=lsp_sid)
        return (
            f'User confirmed: staged `{rel_key}` (reviewer test-run materialization) finalized for this chain.'
            f'{lsp_section} '
            'Continue the nested review / router turn from here.'
        )

    wp = (session.workspace_path or '').strip()
    if not wp:
        return 'Tool error after user confirmation: no workspace is attached to this session.'
    root = Path(wp).resolve()
    lsp_sid = (session_id or current_session_id.get() or '').strip() or None
    target = normalize_relative_path(root, rel_key)
    try:
        write_file_resolved(
            target,
            str(entry.merged_text),
            str(entry.disk_encoding),
            'crlf' if entry.disk_newline == 'crlf' else 'lf',
        )
    except OSError as exc:
        return f'Tool error after user confirmation: could not write staged file `{rel_key}` into the workspace ({exc}).'
    except Exception as exc:
        return f'Tool error after user confirmation: could not encode staged file `{rel_key}` for the workspace ({exc}).'
    entry.old_text = str(entry.merged_text)
    entry.workspace_applied = True
    logger.info('finalize_staged_transfer_after_hitl confirm path=%s', rel_key)
    lsp_section = _post_transfer_lsp_section(session, session_id=lsp_sid)
    return (
        f'User confirmed: staged `{rel_key}` written to the real workspace.{lsp_section} '
        'Continue the nested review / router turn from here.'
    )


def _materialize_staged_python_files(session, overlays: list[tuple[str, object]]) -> tuple[bool, str]:
    root = get_active_workspace_root()
    for rel_key, entry in overlays:
        target = (root / rel_key).resolve()
        if rel_key not in session.test_run_materializations:
            session.test_run_materializations[rel_key] = WorkspaceTestMaterializationEntry(
                existed=target.exists(),
                original_text=entry.old_text if target.exists() else '',
                disk_encoding=entry.disk_encoding,
                disk_newline=entry.disk_newline,
            )
        try:
            write_file_resolved(
                target,
                str(entry.merged_text),
                str(entry.disk_encoding),
                'crlf' if entry.disk_newline == 'crlf' else 'lf',
            )
        except OSError as exc:
            return False, f'Tool error: could not write staged file `{rel_key}` into the workspace ({exc}).'
        except Exception as exc:
            return False, f'Tool error: could not encode staged file `{rel_key}` for the workspace ({exc}).'
    return True, ''


@tool(LIST_STAGED_EDITS_NAME)
def list_staged_edits() -> str:
    """List workspace-relative paths that have a pending staged draft (not yet transferred).

    When: see what is in the staging plane before diff/read/search.
    Not: disk directory listing (use `list_workspace_directory`); file text (use `read_staged_edit` or diff).
    Shape: paths are same keys as `relative_path` on other staging tools (POSIX under workspace root)."""

    sid = current_session_id.get()
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)
    paths = [rel_key for rel_key, _entry in _review_pending_entries(session)]
    if not paths:
        return 'No staged edits are available.'
    return 'Staged edits:\n' + '\n'.join(paths)


@tool(DIFF_STAGED_EDIT_AGAINST_BASELINE_NAME)
def diff_staged_edit_against_baseline(relative_path: str) -> str:
    """Unified diff: workspace baseline at stage time vs current staged `merged_text` (git-style).

    When: mechanical review of what changed for one pending path; prefer before bulk `read_staged_edit`.
    Not: on-disk vs disk (use workspace diff elsewhere); full draft text (use `read_staged_edit` if diff truncated or need context).
    Shape: `relative_path` workspace-relative POSIX; new-file baseline is empty. Empty diff means baseline equals draft—re-read staged content or diagnostics."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    _session, rel_key = got
    entry = _session.pending_edit_stagings[rel_key]
    old_text = str(getattr(entry, 'old_text', '') or '')
    merged_text = str(getattr(entry, 'merged_text', '') or '')
    if old_text == merged_text:
        return (
            f'No textual changes for `{rel_key}`: workspace baseline and staged draft are identical '
            '(empty diff). If you expected edits, re-read with `read_staged_edit` or check diagnostics.'
        )
    body, truncated = _unified_diff_baseline_vs_draft(rel_key, old_text, merged_text)
    if body.startswith('Tool error:'):
        return body
    header = (
        f'Diff `{rel_key}` (--- workspace baseline at stage time, +++ current staged draft)\n\n'
    )
    out = header + body
    if truncated:
        out += f'\n[Diff truncated after {_MAX_STAGED_UNIFIED_DIFF_LINES} lines; use `read_staged_edit` for full draft.]\n'
    capped = truncate_text(out, _MAX_STAGED_DIFF_CHARS)
    if len(capped) < len(out):
        out = capped + '\n[Diff truncated by character cap; use `read_staged_edit` for surrounding context.]\n'
    logger.info(
        'diff_staged_edit_against_baseline path=%s truncated_lines=%s',
        rel_key,
        truncated,
    )
    return out


@tool(READ_STAGED_EDIT_NAME)
def read_staged_edit(
    relative_path: str,
    start_line: int = 1,
    end_line: int = 220,
    include_line_numbers: bool = True,
) -> str:
    """Read a **window** of the pending staged merged draft for one path (temp file, not on-disk workspace).

    When: inspect or copy exact staged text; revise after review; anchor line edits on the draft.
    Not: on-disk checkpoint (use `read_workspace_file` after transfer or when no staging entry).
    Shape: `relative_path` workspace-relative POSIX; must exist in `list_staged_edits`. `start_line`/`end_line` **1-based inclusive** over staged logical lines; window capped like `read_workspace_file`. Encoding is the staging entry’s disk encoding (no separate `encoding` arg). Gutter `n │ text` (U+2502) when `include_line_numbers` true—use false for raw lines (e.g. snippet match)."""

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
    """Grep **pending staging drafts** only (regex; tries ripgrep-style path then Python fallback).

    When: pattern across staged files or one staged file (`relative_path` set).
    Not: on-disk workspace (use `search_workspace`); discovery without staging (use `retrieve_workspace_semantic`).
    Shape: optional `relative_path` filters to that staged path; `max_matches` bounded."""

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

    entries = _review_pending_entries(session)
    if rel_filter:
        entries = [(path, entry) for path, entry in entries if path == rel_filter]
        if not entries:
            return f'Tool error: no staged edit for `{rel_filter}`.'

    grep_matches = _search_staged_edits_grep(entries, query=query, limit=limit)
    if grep_matches is None:
        matches = _search_staged_edits_python(entries, pattern=pattern, limit=limit)
    else:
        matches = grep_matches

    if not matches:
        return 'No matches found in staged edits.'
    return '\n'.join(matches)


@tool(FORMAT_STAGING_FILE_BLACK_NAME)
def format_staging_file_black(relative_path: str) -> str:
    """Run Black on the **staged** `.py` draft in place (updates merged staging content).

    When: staged Python draft has style/indent issues per diagnostics.
    Not: arbitrary extensions (`.py` only); formatting workspace disk directly (transfer first or use workspace tools).
    Shape: `relative_path` workspace-relative POSIX; then `lsp_get_diagnostics` with `refresh_active_document=true` or `read_staged_edit` to verify."""

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
    return (
        f'Black formatted staged `{rel_key}`. Call `lsp_get_diagnostics` with `refresh_active_document=true` to verify, '
        'or `read_staged_edit` before transferring.'
    )


@tool(FORMAT_STAGING_FILE_PRETTIER_NAME)
def format_staging_file_prettier(relative_path: str) -> str:
    """Run Prettier on the **staged** draft in place (updates merged staging content).

    When: staged `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.html`/`.htm`/`.css` draft has style issues per diagnostics.
    Not: other extensions; formatting workspace disk directly (transfer first or use workspace tools).
    Shape: `relative_path` workspace-relative POSIX; then `lsp_get_diagnostics` with `refresh_active_document=true`
    (for TS/JS) or `read_staged_edit` to verify."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    if not is_prettier_managed_path(rel_key):
        return (
            'Tool error: Prettier applies only to staged `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.html`, '
            '`.htm`, `.css` files.'
        )
    try:
        workspace_root = get_active_workspace_root()
    except ValueError as exc:
        return f'Tool error: {exc}'
    entry = session.pending_edit_stagings[rel_key]
    path = Path(entry.temp_path)
    nl: DiskNewline = 'crlf' if entry.disk_newline == 'crlf' else 'lf'
    ok, detail = edit_staging.run_prettier_on_file(
        path,
        workspace_root=workspace_root,
        relative_posix=rel_key,
        encoding=entry.disk_encoding,
        disk_newline=nl,
    )
    if not ok:
        logger.warning('format_staging_file_prettier failed path=%s detail=%s', rel_key, detail)
        return f'Prettier did not change the file (or failed): {detail}'
    try:
        entry.merged_text = edit_staging.read_staging_text(path, entry.disk_encoding)
    except OSError as exc:
        return f'Tool error: could not read staging after Prettier ({exc}).'
    logger.info('format_staging_file_prettier ok path=%s', rel_key)
    return (
        f'Prettier formatted staged `{rel_key}`. For `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`, call '
        '`lsp_get_diagnostics` with `refresh_active_document=true` to verify; use `read_staged_edit` before transferring '
        '(also useful for `.html`/`.htm`/`.css`).'
    )


def _workspace_file_for_format(relative_path: str) -> tuple[str, Path, str, DiskNewline] | str:
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    try:
        root = get_active_workspace_root()
    except ValueError as exc:
        return f'Tool error: {exc}'
    target = normalize_relative_path(root, relative_path)
    rel_key = target.relative_to(root).as_posix()
    if not target.is_file():
        return f'Tool error: no workspace file at `{rel_key}`.'
    try:
        raw = target.read_bytes()
    except OSError as exc:
        return f'Tool error: could not read workspace file ({exc}).'
    disk_enc = (runtime_config.tools.default_workspace_encoding or 'utf-8').strip() or 'utf-8'
    nl: DiskNewline = 'crlf' if b'\r\n' in raw else 'lf'
    return rel_key, target, disk_enc, nl


@tool(FORMAT_WORKSPACE_FILE_BLACK_NAME)
def format_workspace_file_black(relative_path: str) -> str:
    """Run Black on a workspace `.py` file in place (direct Editor + Auto-apply mode).

    When: on-disk Python needs style fixes after a direct write.
    Not: staged drafts (use `format_staging_file_black` when staging is active).
    Shape: workspace-relative POSIX path; then `lsp_get_diagnostics` with `refresh_active_document=true`."""

    got = _workspace_file_for_format(relative_path)
    if isinstance(got, str):
        return got
    rel_key, target, disk_enc, nl = got
    if not rel_key.lower().endswith('.py'):
        return 'Tool error: Black applies only to `.py` workspace files.'
    ok, detail = edit_staging.run_black_on_file(target, encoding=disk_enc, disk_newline=nl)
    if not ok:
        logger.warning('format_workspace_file_black failed path=%s detail=%s', rel_key, detail)
        return f'Black did not change the file (or failed): {detail}'
    logger.info('format_workspace_file_black ok path=%s', rel_key)
    return (
        f'Black formatted workspace `{rel_key}`. Call `lsp_get_diagnostics` with '
        '`refresh_active_document=true` to verify.'
    )


@tool(FORMAT_WORKSPACE_FILE_PRETTIER_NAME)
def format_workspace_file_prettier(relative_path: str) -> str:
    """Run Prettier on a workspace file in place (direct Editor + Auto-apply mode).

    When: on-disk `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.html`/`.htm`/`.css` needs style fixes.
    Not: staged drafts (use `format_staging_file_prettier` when staging is active).
    Shape: workspace-relative POSIX path; then `lsp_get_diagnostics` with `refresh_active_document=true` for TS/JS."""

    got = _workspace_file_for_format(relative_path)
    if isinstance(got, str):
        return got
    rel_key, target, disk_enc, nl = got
    if not is_prettier_managed_path(rel_key):
        return (
            'Tool error: Prettier applies only to workspace `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.html`, '
            '`.htm`, `.css` files.'
        )
    try:
        workspace_root = get_active_workspace_root()
    except ValueError as exc:
        return f'Tool error: {exc}'
    ok, detail = edit_staging.run_prettier_on_file(
        target,
        workspace_root=workspace_root,
        relative_posix=rel_key,
        encoding=disk_enc,
        disk_newline=nl,
    )
    if not ok:
        logger.warning('format_workspace_file_prettier failed path=%s detail=%s', rel_key, detail)
        return f'Prettier did not change the file (or failed): {detail}'
    logger.info('format_workspace_file_prettier ok path=%s', rel_key)
    return (
        f'Prettier formatted workspace `{rel_key}`. For `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`, call '
        '`lsp_get_diagnostics` with `refresh_active_document=true` to verify.'
    )


def _overlay_combined_output(stdout_chunks: list[str], stderr_chunks: list[str]) -> str:
    stdout = ''.join(stdout_chunks)
    stderr = ''.join(stderr_chunks)
    if stderr:
        return f'{stdout}\n[stderr]\n{stderr}' if stdout else f'[stderr]\n{stderr}'
    return stdout


@tool(RUN_STAGING_OVERLAY_COMMAND_NAME)
async def run_staging_overlay_command(command_argv_json: str, cwd_relative: str = '') -> str:
    """Run `command_argv_json` (JSON argv array, no shell) in an ephemeral overlay: workspace + pending staged drafts.

    When: pytest/npm tests against drafts without writing real workspace (requires Settings → Allow staging overlay commands).
    Not: substitute for `transfer_staged_file_to_workspace`; real workspace unchanged until transfer/reject flow.
    Shape: `cwd_relative` optional under overlay root. Heavy dirs linked from workspace. Still finish review with transfer/reject."""

    if not getattr(runtime_config.tools, 'allow_staging_overlay_commands', False):
        return (
            'Tool error: staging overlay commands are disabled. Enable **Allow staging overlay commands** '
            'in Settings → Tools, then try again.'
        )
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)
    argv, parse_err = parse_command_argv_json(command_argv_json)
    if argv is None:
        return parse_err
    pending = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=RUN_STAGING_OVERLAY_COMMAND_NAME,
        tool_input={'command_argv_json': command_argv_json, 'cwd_relative': cwd_relative},
    )
    if pending:
        return pending
    try:
        workspace_root = get_active_workspace_root()
    except ValueError as exc:
        return f'Tool error: {exc}'

    direct = direct_workspace_edits_active(session, apply_mode=True)
    overlay_parent: Path | None = None
    if direct:
        command_root = workspace_root.resolve()
        cwd, cwd_err = resolve_overlay_cwd(command_root, cwd_relative)
        if cwd is None:
            return cwd_err
        cwd_label = 'workspace'
    else:
        overlay_root, overlay_parent, build_err = build_staging_test_overlay(session, workspace_root, sid)
        if overlay_root is None or overlay_parent is None:
            return build_err or 'Tool error: could not build staging overlay.'
        command_root = overlay_root
        cwd, cwd_err = resolve_overlay_cwd(command_root, cwd_relative)
        if cwd is None:
            remove_overlay_parent(overlay_parent)
            return cwd_err
        cwd_label = 'overlay'

    await ensure_session_python_workspace_env(
        session,
        allow_workspace_root_fallback=False,
        bootstrap_dependencies=False,
        emit_chunk=None,
    )
    proc_env = with_subprocess_color_env(session_workspace_subprocess_env(session))

    rendered = ' '.join(argv)
    await _emit_project_review_chunk(
        sid,
        f'$ {rendered}\n',
        stream_tag=_OVERLAY_STREAM_TAG,
        label=_OVERLAY_STREAM_LABEL,
    )
    exit_code: int | None = None
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    watch_mode = argv_implies_watch_mode(argv)
    tracker = SmokeOutputTracker()

    def _track_output(text: str) -> None:
        tracker.feed(text)

    try:
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=proc_env,
            )
        except OSError as exc:
            await _emit_project_review_tool_complete(
                sid,
                stream_tag=_OVERLAY_STREAM_TAG,
                label=_OVERLAY_STREAM_LABEL,
                exit_code=None,
                output_excerpt='',
            )
            return f'Tool error: could not start command ({exc}).'

        stdout_task = asyncio.create_task(
            _pump_subprocess_stream(
                proc.stdout,
                session_id=sid,
                emit_prefix='',
                capture_chunks=stdout_chunks,
                stream_tag=_OVERLAY_STREAM_TAG,
                label=_OVERLAY_STREAM_LABEL,
                on_text=_track_output,
            )
        )
        stderr_task = asyncio.create_task(
            _pump_subprocess_stream(
                proc.stderr,
                session_id=sid,
                emit_prefix='[stderr] ',
                capture_chunks=stderr_chunks,
                stream_tag=_OVERLAY_STREAM_TAG,
                label=_OVERLAY_STREAM_LABEL,
                on_text=_track_output,
            )
        )
        wait_task = asyncio.create_task(proc.wait())
        abort_task = asyncio.create_task(session.abort_event.wait())

        async def _emit_overlay_status(message: str) -> None:
            await _emit_project_review_chunk(
                sid,
                message,
                stream_tag=_OVERLAY_STREAM_TAG,
                label=_OVERLAY_STREAM_LABEL,
            )

        smoke_outcome: str | None = None
        smoke_passed = False
        smoke_steady = False
        smoke_readiness = False
        try:
            if watch_mode:
                smoke_result = await wait_for_smoke_completion(
                    proc,
                    wait_task=wait_task,
                    abort_task=abort_task,
                    tracker=tracker,
                    terminate_fn=_terminate_process,
                    emit_status=_emit_overlay_status,
                    watch_mode=True,
                )
                exit_code = smoke_result.exit_code
                smoke_passed = smoke_result.passed
                smoke_steady = smoke_result.steady_state
                smoke_readiness = smoke_result.readiness_detected
                smoke_outcome = 'passed' if smoke_result.passed else 'failed'
                if smoke_result.stop_reason is SmokeStopReason.ABORTED:
                    replay = _overlay_combined_output(stdout_chunks, stderr_chunks).strip()
                    excerpt = replay[-12_000:] if len(replay) > 12_000 else replay
                    await _emit_project_review_tool_complete(
                        sid,
                        stream_tag=_OVERLAY_STREAM_TAG,
                        label=_OVERLAY_STREAM_LABEL,
                        exit_code=exit_code,
                        output_excerpt=excerpt.strip(),
                        outcome='failed',
                    )
                    return 'Aborted by user.'
            else:
                timeout_sec = (
                    float(NEMO_SUBPROCESS_TIMEOUT_SEC)
                    if NEMO_SUBPROCESS_TIMEOUT_SEC and NEMO_SUBPROCESS_TIMEOUT_SEC > 0
                    else None
                )
                if timeout_sec is not None:
                    done, _pending = await asyncio.wait(
                        {wait_task, abort_task},
                        timeout=timeout_sec,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if not done:
                        await _emit_project_review_chunk(
                            sid,
                            '\n[staging overlay command timed out]\n',
                            stream_tag=_OVERLAY_STREAM_TAG,
                            label=_OVERLAY_STREAM_LABEL,
                        )
                        await _terminate_process(proc)
                        await wait_task
                        exit_code = proc.returncode
                    elif wait_task in done:
                        exit_code = await wait_task
                    elif abort_task in done and session.abort_event.is_set():
                        await _emit_project_review_chunk(
                            sid,
                            '\n[staging overlay command aborted by user]\n',
                            stream_tag=_OVERLAY_STREAM_TAG,
                            label=_OVERLAY_STREAM_LABEL,
                        )
                        await _terminate_process(proc)
                        await wait_task
                        exit_code = proc.returncode
                else:
                    done, _pending = await asyncio.wait({wait_task, abort_task}, return_when=asyncio.FIRST_COMPLETED)
                    if wait_task in done:
                        exit_code = await wait_task
                    elif abort_task in done and session.abort_event.is_set():
                        await _emit_project_review_chunk(
                            sid,
                            '\n[staging overlay command aborted by user]\n',
                            stream_tag=_OVERLAY_STREAM_TAG,
                            label=_OVERLAY_STREAM_LABEL,
                        )
                        await _terminate_process(proc)
                        await wait_task
                        exit_code = proc.returncode
                if abort_task.done() and session.abort_event.is_set() and not watch_mode:
                    replay = _overlay_combined_output(stdout_chunks, stderr_chunks).strip()
                    excerpt = replay[-12_000:] if len(replay) > 12_000 else replay
                    await _emit_project_review_tool_complete(
                        sid,
                        stream_tag=_OVERLAY_STREAM_TAG,
                        label=_OVERLAY_STREAM_LABEL,
                        exit_code=exit_code,
                        output_excerpt=excerpt.strip(),
                        outcome='failed',
                    )
                    return 'Aborted by user.'
        finally:
            if not abort_task.done():
                abort_task.cancel()
                try:
                    await abort_task
                except asyncio.CancelledError:
                    pass
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

        combined = _overlay_combined_output(stdout_chunks, stderr_chunks).strip()
        excerpt = combined[-12_000:] if len(combined) > 12_000 else combined
        if watch_mode:
            passed = smoke_passed
            if smoke_steady and smoke_readiness:
                status = 'passed (dev server readiness detected)'
            elif smoke_steady:
                status = 'passed (startup reached steady state)'
            else:
                status = 'passed' if passed else 'failed'
        else:
            passed = exit_code == 0
            status = 'passed' if passed else 'failed'
        await _emit_project_review_tool_complete(
            sid,
            stream_tag=_OVERLAY_STREAM_TAG,
            label=_OVERLAY_STREAM_LABEL,
            exit_code=exit_code,
            output_excerpt=excerpt.strip(),
            outcome=smoke_outcome if watch_mode else ('passed' if passed else 'failed'),
        )
        body = (
            'Command summary:\n'
            f'- Command: `{rendered}`\n'
            f'- Working directory ({cwd_label}): `{cwd}`\n'
            f'- Watch mode: {"yes" if watch_mode else "no"}\n'
            f'- Result: {status}\n'
            f'- Exit code: {exit_code if exit_code is not None else "unknown"}\n'
        )
        if combined:
            body += f'\nCaptured output:\n{combined}'
        logger.info('run_staging_overlay_command exit_code=%s cwd=%s direct=%s watch=%s', exit_code, cwd, direct, watch_mode)
        return truncate_text_head_tail(body, _MAX_OVERLAY_OUTPUT_CHARS)
    finally:
        if overlay_parent is not None:
            remove_overlay_parent(overlay_parent)


def _build_staged_transfer_hitl_payload(session, rel_key: str, entry) -> tuple[dict | None, str | None]:
    """Workspace baseline vs staged merged text for chat diff review (no disk write)."""
    root = get_active_workspace_root()
    target = (root / rel_key).resolve()
    old_text = ''
    if target.is_file():
        try:
            raw_existing = target.read_bytes()
            old_text = decode_for_tools(raw_existing, str(entry.disk_encoding))
        except OSError as exc:
            return None, f'could not read workspace file for diff ({exc})'
    merged = str(entry.merged_text)
    nl = 'crlf' if entry.disk_newline == 'crlf' else 'lf'
    payload, err = build_file_diff_payload(
        rel_key,
        old_text,
        merged,
        disk_encoding=str(entry.disk_encoding),
        disk_newline=nl,
    )
    if err:
        return None, err
    payload['stagedTransferHitl'] = True
    return payload, None


def run_staged_transfer_to_workspace(session: SessionState, rel_key: str) -> str:
    """Apply the same path as :func:`transfer_staged_file_to_workspace` after a staging entry is present (tool or inline)."""
    rel_key = rel_key.strip().replace('\\', '/')
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    entry = session.pending_edit_stagings.get(rel_key)
    if not entry:
        return f'Tool error: no staged edit for `{rel_key}`.'
    if _entry_workspace_applied(entry):
        return (
            f'Tool error: staged `{rel_key}` is already approved in the workspace for this chain. '
            'It is no longer pending review. For follow-up edits, read the live file with `read_workspace_file` and '
            'then stage the next revision with `stage_workspace_file_overwrite` or the matching '
            '`lsp_update_python_file` / `lsp_update_typescript_file` / `lsp_update_gdscript_file`.'
        )

    if not session.auto_apply_mode:
        if rel_key in session.test_run_materializations:
            payload, err = _build_staged_transfer_hitl_payload(session, rel_key, entry)
            if err:
                return f'Tool error: {err}'
            session.pending_diff_payload = payload
            session.pending_staged_transfer_hitl = PendingStagedTransferHitl(relative_path=rel_key)
            logger.info('run_staged_transfer_to_workspace awaiting hitl (test_run) path=%s', rel_key)
            return (
                f'Staged `{rel_key}` is already on disk from the reviewer test run; **human confirmation** is '
                'required before this chain treats it as approved. A diff card will appear in chat—approve the '
                'transfer or return it for re-review with feedback for the code review / writer path. '
                'Stop this review turn after calling this tool.'
            )
        payload, err = _build_staged_transfer_hitl_payload(session, rel_key, entry)
        if err:
            return f'Tool error: {err}'
        session.pending_diff_payload = payload
        session.pending_staged_transfer_hitl = PendingStagedTransferHitl(relative_path=rel_key)
        logger.info('run_staged_transfer_to_workspace awaiting hitl path=%s', rel_key)
        return (
            f'Staged `{rel_key}` is ready to land in the real workspace; **human confirmation** is required. '
            'A diff card will appear in chat—approve the transfer to write the workspace, or return for re-review '
            'with feedback so the code review specialist can iterate. Stop this review turn after calling this tool.'
        )

    if rel_key in session.test_run_materializations:
        out = (
            f'Staged `{rel_key}` is already saved in the workspace from the reviewer test run. '
            'Keeping the workspace copy as the approved version.'
        )
        _mark_materialization_approved(session, rel_key)
    else:
        root = get_active_workspace_root()
        target = (root / rel_key).resolve()
        try:
            write_file_resolved(
                target,
                str(entry.merged_text),
                str(entry.disk_encoding),
                'crlf' if entry.disk_newline == 'crlf' else 'lf',
            )
        except OSError as exc:
            return f'Tool error: could not write staged file `{rel_key}` into the workspace ({exc}).'
        except Exception as exc:
            return f'Tool error: could not encode staged file `{rel_key}` for the workspace ({exc}).'
        out = f'Approved staged `{rel_key}` into the real workspace.'
    entry.old_text = str(entry.merged_text)
    entry.workspace_applied = True
    lsp_section = _post_transfer_lsp_section(session, session_id=current_session_id.get())
    logger.info('run_staged_transfer_to_workspace path=%s', rel_key)
    return (
        f'Transferred staged `{rel_key}` to the real workspace and kept the staged draft for the current chain. '
        f'{out}{lsp_section} Stop this review turn after calling this tool.'
    )


@tool(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME)
def transfer_staged_file_to_workspace(relative_path: str) -> str:
    """Approve landing staged draft: writes workspace (or queues HITL diff when auto-apply off).

    When: draft is correct and should become the on-disk checkpoint for this path.
    Not: request writer changes (use `reject_staged_workspace_edit` with feedback); reading only (use `read_staged_edit`).
    Shape: `relative_path` workspace-relative POSIX. After approval, follow-up reads use `read_workspace_file` / LSP on disk.
    Workspace LSP refresh runs **once** after every staged path in this chain is transferred (not after each file)."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    return run_staged_transfer_to_workspace(session, rel_key)


@tool(REJECT_STAGED_WORKSPACE_EDIT_NAME)
def reject_staged_workspace_edit(relative_path: str, feedback: str) -> str:
    """Fail review: block transfer and return concrete `feedback` so the writer can revise the staged draft.

    When: staged content is wrong, incomplete, or unsafe—needs another staging iteration.
    Not: pass / ship (use `transfer_staged_file_to_workspace`); generic praise without revision request.
    Shape: `relative_path` workspace-relative POSIX; `feedback` must say what to fix."""

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    rollback_test_run_materializations(session)
    fb = (feedback or '').strip() or '(no details)'
    logger.info('reject_staged_workspace_edit path=%s', rel_key)
    return (
        f'Rejected staged edit for `{rel_key}`. Return this to the router so it can hand off to the create/update '
        f'specialist again. Keep revising the existing staged draft; it will be cleaned up automatically when the '
        f'nested workspace chain finishes. Stop this review turn after calling this tool.\n\nReviewer feedback:\n{fb}'
    )


def code_review_specialist_tools(*, direct: bool = False) -> tuple[list[object], dict[str, object]]:
    if direct:
        tools: list[object] = [
            lsp_get_diagnostics,
            format_workspace_file_black,
            format_workspace_file_prettier,
            run_staging_overlay_command,
        ]
    else:
        tools = [
            list_staged_edits,
            diff_staged_edit_against_baseline,
            read_staged_edit,
            search_staged_edits,
            lsp_get_diagnostics,
            format_staging_file_black,
            format_staging_file_prettier,
            run_staging_overlay_command,
            transfer_staged_file_to_workspace,
            reject_staged_workspace_edit,
        ]
    m = {t.name: t for t in tools}
    return tools, m
