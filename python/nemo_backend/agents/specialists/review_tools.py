"""Tools for the nested code-review specialist (staging read/format/transfer/reject)."""

from __future__ import annotations

import difflib
import logging
import re
from pathlib import Path
from typing import Literal

from langchain_core.tools import tool

from nemo_backend import edit_staging
from nemo_backend.diff_payload import build_file_diff_payload
from nemo_backend.domain import PendingStagedTransferHitl, WorkspaceTestMaterializationEntry
from nemo_backend.edit_tool import APPROVE_STAGED_WORKSPACE_EDIT_NAME
from nemo_backend.lsp.file_policy import is_lsp_managed_path, lsp_server_for_path
from nemo_backend.lsp.manager import sync_session_document
from nemo_backend.lsp.tools import lsp_get_diagnostics
from nemo_backend.search_backend import SearchCandidate, run_grep_line_search
from nemo_backend.state import current_session_id, get_session, mutation_tools_blocked_reason, runtime_config
from nemo_backend.workspace_text_io import DiskNewline, decode_for_tools, write_file_resolved
from nemo_backend.workspace_tools import get_active_workspace_root, normalize_relative_path, truncate_text

logger = logging.getLogger('nemo.staging')

REJECT_STAGED_WORKSPACE_EDIT_NAME = 'reject_staged_workspace_edit'
LIST_STAGED_EDITS_NAME = 'list_staged_edits'
READ_STAGED_EDIT_NAME = 'read_staged_edit'
SEARCH_STAGED_EDITS_NAME = 'search_staged_edits'
FORMAT_STAGING_FILE_BLACK_NAME = 'format_staging_file_black'
TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME = 'transfer_staged_file_to_workspace'
DIFF_STAGED_EDIT_AGAINST_BASELINE_NAME = 'diff_staged_edit_against_baseline'
# Cap unified-diff lines so tool output stays model-friendly (git-style hunks).
_MAX_STAGED_UNIFIED_DIFF_LINES = 2500
_MAX_STAGED_DIFF_CHARS = 480_000
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
            'then stage the next revision with `stage_workspace_file_overwrite` or `lsp_update_python_file`.'
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
        return (
            f'User confirmed: staged `{rel_key}` (reviewer test-run materialization) finalized for this chain. '
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
    lsp_note = ''
    if is_lsp_managed_path(rel_key):
        try:
            diagnostics = sync_session_document(
                rel_key,
                str(entry.merged_text),
                session_id=lsp_sid,
                scope='workspace',
            )
            ls_label = lsp_server_for_path(rel_key) or 'lsp'
            lsp_note = f' {ls_label} LSP diagnostics: {len(diagnostics)} issue(s).'
        except Exception as exc:
            logger.warning('workspace LSP sync failed after hitl transfer path=%s err=%s', rel_key, exc)
            ls_label = lsp_server_for_path(rel_key) or 'lsp'
            lsp_note = f' {ls_label} LSP sync failed: {exc}.'
    entry.old_text = str(entry.merged_text)
    entry.workspace_applied = True
    logger.info('finalize_staged_transfer_after_hitl confirm path=%s', rel_key)
    return (
        f'User confirmed: staged `{rel_key}` written to the real workspace.{lsp_note} '
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
    """List workspace-relative paths currently staged for code review."""

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
    """Unified diff of workspace baseline vs staged draft (git-style line compare).

    Baseline is the workspace snapshot captured when staging started (`old_text`); the draft is current
    staged merged content (`merged_text`). For new files the baseline is empty. Call once per pending
    path after `list_staged_edits` before relying on full-file reads."""

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


@tool(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME)
def transfer_staged_file_to_workspace(relative_path: str) -> str:
    """PASS / approve this staged draft for the current step.

    Call when the staged file correctly satisfies the task step and needs no further code changes from the
    file-write specialist. When **auto-apply** is off, the real workspace is updated only after the human
    confirms the transfer in chat (or returns it for re-review). When auto-apply is on, this writes immediately.

    Do not call this if you still want the writer to change the code—use `reject_staged_workspace_edit` instead.
    """

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    entry = session.pending_edit_stagings.get(rel_key)
    if not entry:
        return f'Tool error: no staged edit for `{rel_key}`.'

    if not session.auto_apply_mode:
        if rel_key in session.test_run_materializations:
            payload, err = _build_staged_transfer_hitl_payload(session, rel_key, entry)
            if err:
                return f'Tool error: {err}'
            session.pending_diff_payload = payload
            session.pending_staged_transfer_hitl = PendingStagedTransferHitl(relative_path=rel_key)
            logger.info('transfer_staged_file_to_workspace awaiting hitl (test_run) path=%s', rel_key)
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
        logger.info('transfer_staged_file_to_workspace awaiting hitl path=%s', rel_key)
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
        lsp_note = ''
        if is_lsp_managed_path(rel_key):
            try:
                diagnostics = sync_session_document(
                    rel_key,
                    str(entry.merged_text),
                    session_id=current_session_id.get(),
                    scope='workspace',
                )
                ls_label = lsp_server_for_path(rel_key) or 'lsp'
                lsp_note = f' {ls_label} LSP diagnostics: {len(diagnostics)} issue(s).'
            except Exception as exc:
                logger.warning('workspace LSP sync failed after staged transfer path=%s err=%s', rel_key, exc)
                ls_label = lsp_server_for_path(rel_key) or 'lsp'
                lsp_note = f' {ls_label} LSP sync failed: {exc}.'
        out = f'Approved staged `{rel_key}` into the real workspace.{lsp_note}'
    entry.old_text = str(entry.merged_text)
    entry.workspace_applied = True
    logger.info('transfer_staged_file_to_workspace path=%s', rel_key)
    return (
        f'Transferred staged `{rel_key}` to the real workspace and kept the staged draft for the current chain. '
        f'{out} Stop this review turn after calling this tool.'
    )


@tool(APPROVE_STAGED_WORKSPACE_EDIT_NAME)
def approve_staged_workspace_edit(relative_path: str) -> str:
    """Same as `transfer_staged_file_to_workspace`: PASS / approve the staged draft into the workspace."""

    return transfer_staged_file_to_workspace.invoke({'relative_path': relative_path})


@tool(REJECT_STAGED_WORKSPACE_EDIT_NAME)
def reject_staged_workspace_edit(relative_path: str, feedback: str) -> str:
    """FAIL / needs revision: block this draft and send the writer concrete fix instructions.

    Use ONLY when the staged code is wrong, incomplete, unsafe, or does not meet the step—so the file-write
    specialist must produce a new staged version. The `feedback` must describe what is wrong and what to change.

    Do NOT use this tool to summarize successful work, to say changes were applied as requested, or to ask for
    a human "final approval"—those describe a PASS. For a passing draft call `transfer_staged_file_to_workspace`
    instead.
    """

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


def code_review_specialist_tools() -> tuple[list[object], dict[str, object]]:
    tools: list[object] = [
        list_staged_edits,
        diff_staged_edit_against_baseline,
        read_staged_edit,
        search_staged_edits,
        lsp_get_diagnostics,
        format_staging_file_black,
        transfer_staged_file_to_workspace,
        reject_staged_workspace_edit,
    ]
    m = {t.name: t for t in tools}
    return tools, m
