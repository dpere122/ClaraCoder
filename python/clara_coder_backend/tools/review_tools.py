"""Staging review tools for the outer Clara agent (read/format/transfer/reject/discard)."""

from __future__ import annotations

import asyncio
import difflib
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Annotated, Literal

from langchain_core.tools import tool

from clara_coder_backend.staging import edit_staging
from clara_coder_backend.tools.project_review_tools import (
    RollingTextBuffer,
    _emit_project_review_chunk,
    _emit_project_review_tool_complete,
    _pump_subprocess_stream,
    _terminate_process,
)
from clara_coder_backend.config import CLARA_SUBPROCESS_TIMEOUT_SEC
from clara_coder_backend.runtime.subprocess_smoke import (
    SmokeOutputTracker,
    SmokeStopReason,
    argv_implies_watch_mode,
    wait_for_smoke_completion,
)
from clara_coder_backend.staging.diff_payload import build_file_diff_payload
from clara_coder_backend.domain import PendingStagedTransferHitl, SessionState, WorkspaceTestMaterializationEntry
from clara_coder_backend.lsp.diagnostics import format_diagnostics_summary, indentation_followup_guidance
from clara_coder_backend.lsp.file_policy import is_lsp_managed_path, is_prettier_managed_path, lsp_server_for_path
from clara_coder_backend.lsp.manager import sync_session_document
from clara_coder_backend.tools.lsp_tools import lsp_get_diagnostics
from clara_coder_backend.tools.tool_conventions import (
    GUTTER,
    ONE_BASED,
    RELATIVE_PATH,
    VERIFY_LSP,
    clamp_line_window,
    describe,
)
from clara_coder_backend.runtime.python_env import (
    ensure_session_python_workspace_env,
    session_workspace_subprocess_env,
    with_subprocess_color_env,
)
from clara_coder_backend.workspace.search_backend import SearchCandidate, run_grep_line_search
from clara_coder_backend.staging.materializations import (
    restore_materialized_path,
    rollback_test_run_materializations,
)
from clara_coder_backend.staging.staging_test_overlay import (
    build_staging_test_overlay,
    parse_command_argv_json,
    remove_overlay_parent,
    resolve_overlay_cwd,
    validate_overlay_command_argv,
)
from clara_coder_backend.tools.deferred_hitl import maybe_await_hitl_for_deferred_tool
from clara_coder_backend.stream_tags import TOOL_OVERLAY_STREAM_TAG
from clara_coder_backend.session.file_journal import emit_edit_journal
from clara_coder_backend.session.state import (
    agent_formatters_enabled,
    current_session_id,
    direct_workspace_edits_active,
    get_session,
    mutation_tools_blocked_reason,
    runtime_config,
)
from clara_coder_backend.workspace.workspace_text_io import DiskNewline, decode_for_tools, write_file_resolved
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path, truncate_text, truncate_text_head_tail

logger = logging.getLogger('clara.staging')

REJECT_STAGED_WORKSPACE_EDIT_NAME = 'reject_staged_workspace_edit'
DISCARD_STAGED_EDITS_NAME = 'discard_staged_edits'
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
_FORMATTERS_DISABLED = (
    'Tool error: Black and Prettier are disabled. Enable **Use Black and Prettier in the agent flow** '
    'in Settings → Tools, then try again.'
)
_OVERLAY_STREAM_LABEL = 'Staging overlay'
_SUBPROCESS_READ_SIZE = 65_536
_MAX_OVERLAY_OUTPUT_CHARS = 120_000
# Cap unified-diff lines so tool output stays model-friendly (git-style hunks).
_MAX_STAGED_UNIFIED_DIFF_LINES = 2500
_MAX_STAGED_DIFF_CHARS = 480_000
_READ_FILE_GUTTER_SEP = ' │ '
_POST_TRANSFER_BATCH_LSP_MAX_CHARS = 14_000
_MAX_TRANSFER_BATCH = 50


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


def pending_untransferred_staging_paths(session) -> list[str]:
    """Workspace-relative paths with staged drafts not yet transferred for this chain."""
    return [rel_key for rel_key, _ in _review_pending_entries(session)]


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
    restore_materialized_path(session, rel_key)


def _mark_materialization_approved(session, rel_key: str) -> None:
    session.test_run_materializations.pop(rel_key, None)


def _normalize_transfer_paths(
    relative_paths: list[str] | None,
    relative_path: str,
) -> tuple[list[str] | None, str | None]:
    """Normalize ``relative_paths`` / legacy ``relative_path`` into a deduped POSIX list."""
    raw: list[str] = []
    if relative_paths:
        raw.extend(str(p) for p in relative_paths)
    rp = (relative_path or '').strip()
    if rp:
        raw.append(rp)
    if not raw:
        return None, 'Tool error: provide at least one path via `relative_paths` or `relative_path`.'
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        p = item.strip().replace('\\', '/')
        if not p or p == '.':
            continue
        while p.startswith('./'):
            p = p[2:]
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    if not out:
        return None, 'Tool error: no valid workspace-relative paths provided.'
    if len(out) > _MAX_TRANSFER_BATCH:
        return None, f'Tool error: transfer batch is limited to {_MAX_TRANSFER_BATCH} paths at a time.'
    return out, None


def _validate_transfer_batch(session: SessionState, paths: list[str]) -> tuple[list[str], str | None]:
    """Validate every path has a pending staged draft not yet transferred."""
    errors: list[str] = []
    validated: list[str] = []
    for rel_key in paths:
        entry = session.pending_edit_stagings.get(rel_key)
        if not entry:
            errors.append(f'no staged edit for `{rel_key}`')
            continue
        if _entry_workspace_applied(entry):
            errors.append(
                f'staged `{rel_key}` is already approved in the workspace for this chain '
                '(use `read_workspace_file` and stage a follow-up revision if needed)'
            )
            continue
        validated.append(rel_key)
    if errors:
        return [], 'Tool error: ' + '; '.join(errors) + '.'
    return validated, None


def _apply_staged_transfer_confirm(
    session: SessionState,
    rel_key: str,
    entry: object,
    *,
    session_id: str | None,
) -> str | None:
    """Write one confirmed staged path to the real workspace. Returns error text or None on success."""
    if _entry_workspace_applied(entry):
        return None
    if rel_key in session.test_run_materializations:
        _mark_materialization_approved(session, rel_key)
        entry.old_text = str(entry.merged_text)  # type: ignore[attr-defined]
        entry.workspace_applied = True  # type: ignore[attr-defined]
        logger.info('_apply_staged_transfer_confirm test_run path=%s', rel_key)
        return None
    wp = (session.workspace_path or '').strip()
    if not wp:
        return f'Tool error after user confirmation: no workspace is attached to this session.'
    root = Path(wp).resolve()
    target = normalize_relative_path(root, rel_key)
    try:
        write_file_resolved(
            target,
            str(entry.merged_text),  # type: ignore[attr-defined]
            str(entry.disk_encoding),  # type: ignore[attr-defined]
            'crlf' if entry.disk_newline == 'crlf' else 'lf',  # type: ignore[attr-defined]
        )
        emit_edit_journal(
            session,
            rel_key,
            str(entry.old_text),  # type: ignore[attr-defined]
            before_existed=bool(getattr(entry, 'before_existed', True)),
            encoding=str(entry.disk_encoding),  # type: ignore[attr-defined]
            newline='crlf' if entry.disk_newline == 'crlf' else 'lf',  # type: ignore[attr-defined]
        )
    except OSError as exc:
        return f'Tool error after user confirmation: could not write staged file `{rel_key}` into the workspace ({exc}).'
    except Exception as exc:
        return f'Tool error after user confirmation: could not encode staged file `{rel_key}` for the workspace ({exc}).'
    entry.old_text = str(entry.merged_text)  # type: ignore[attr-defined]
    entry.workspace_applied = True  # type: ignore[attr-defined]
    logger.info('_apply_staged_transfer_confirm path=%s session_id=%s', rel_key, session_id)
    return None


def _re_review_message(rel_key: str, user_note: str) -> str:
    fb = (user_note or '').strip() or '(no details)'
    return (
        f'**Staged transfer returned for re-review (user did not approve landing this draft in the workspace '
        f'yet).** Path: `{rel_key}`.\n\n'
        'Revise the staged draft (`diff_staged_edit_against_baseline` / `read_staged_edit`), then call '
        '`transfer_staged_file_to_workspace` again when ready. '
        'Or call `discard_staged_edits` for this path to abandon the draft without landing.\n\n'
        f'User / reviewer feedback:\n{fb}'
    )


def _build_batch_complete_message(
    session: SessionState,
    pending: PendingStagedTransferHitl,
    *,
    session_id: str | None,
) -> str:
    approved = [p for p in pending.relative_paths if pending.resolved.get(p) == 'confirm']
    re_review = [p for p in pending.relative_paths if pending.resolved.get(p) == 're_review']
    parts: list[str] = []
    if approved:
        quoted = ', '.join(f'`{p}`' for p in approved)
        parts.append(f'User approved staged transfer for: {quoted}.')
    for rel_key in re_review:
        parts.append(_re_review_message(rel_key, pending.feedback.get(rel_key, '')))
    lsp_section = _post_transfer_lsp_section(session, session_id=session_id)
    body = '\n\n'.join(parts)
    if lsp_section:
        body = f'{body}{lsp_section}'
    if approved or re_review:
        body = f'{body}\n\nContinue the outer agent turn from here.'
    return body


def staged_transfer_batch_sse_payload(pending: PendingStagedTransferHitl, files: list[dict]) -> dict:
    """Shape for SSE ``stagedTransferBatch`` / frontend ``StagedTransferBatchPayload``."""
    return {
        'version': 1,
        'requestId': pending.request_id,
        'files': files,
    }


def resolve_staged_transfer_batch_file(
    session: SessionState,
    *,
    request_id: str,
    relative_path: str,
    action: Literal['confirm', 're_review'],
    user_note: str,
    session_id: str | None = None,
) -> tuple[bool, str]:
    """Apply one per-file decision in a batch HITL. Returns ``(batch_complete, message)``."""
    pending = session.pending_staged_transfer_hitl
    if pending is None:
        return False, ''
    rid = (request_id or '').strip()
    if not rid or pending.request_id != rid:
        return False, 'Staged transfer confirmation ignored (stale or mismatched request).'
    rel_key = relative_path.strip().replace('\\', '/')
    if rel_key not in pending.relative_paths:
        return False, f'Staged transfer confirmation ignored: `{rel_key}` is not in the pending batch.'
    if rel_key in pending.resolved:
        return False, f'Staged transfer confirmation ignored: `{rel_key}` was already resolved in this batch.'

    entry = session.pending_edit_stagings.get(rel_key)
    if action == 'confirm':
        if entry is None:
            pending.resolved[rel_key] = 'confirm'
        elif _entry_workspace_applied(entry):
            pending.resolved[rel_key] = 'confirm'
        else:
            err = _apply_staged_transfer_confirm(session, rel_key, entry, session_id=session_id)
            if err:
                return False, err
            pending.resolved[rel_key] = 'confirm'
    else:
        pending.resolved[rel_key] = 're_review'
        pending.feedback[rel_key] = (user_note or '').strip() or '(no details)'

    remaining = [p for p in pending.relative_paths if p not in pending.resolved]
    if remaining:
        return False, ''

    sid = (session_id or current_session_id.get() or '').strip() or None
    msg = _build_batch_complete_message(session, pending, session_id=sid)
    session.pending_staged_transfer_hitl = None
    session.pending_staged_transfer_batch_payload = None
    return True, msg


def finalize_staged_transfer_after_hitl(
    session,
    action: Literal['confirm', 're_review'],
    user_note: str,
    *,
    session_id: str | None = None,
) -> str:
    """Legacy single-call finalize when the UI resolves the whole pending batch at once.

    When ``pending.relative_paths`` has one entry, applies that path in one step (backward compat).
    """
    pending = session.pending_staged_transfer_hitl
    if pending is None:
        return ''
    if len(pending.relative_paths) != 1:
        return ''
    rel_key = pending.relative_paths[0]
    complete, msg = resolve_staged_transfer_batch_file(
        session,
        request_id=pending.request_id,
        relative_path=rel_key,
        action=action,
        user_note=user_note,
        session_id=session_id,
    )
    return msg if complete else ''


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


@tool(LIST_STAGED_EDITS_NAME, description=describe(
        'List workspace-relative paths that have a pending staged draft (not yet transferred).',
        when='see what is in the staging plane before diff/read/search.',
        not_='disk directory listing (use `list_workspace_directory`); file text (use `read_staged_edit` or diff).',
        shape=f'paths are same keys as `relative_path` on other staging tools ({RELATIVE_PATH})',
    ))
def list_staged_edits() -> str:

    sid = current_session_id.get()
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)
    paths = [rel_key for rel_key, _entry in _review_pending_entries(session)]
    if not paths:
        return 'No staged edits are available.'
    return 'Staged edits:\n' + '\n'.join(paths)


@tool(DIFF_STAGED_EDIT_AGAINST_BASELINE_NAME, description=describe(
        'Unified diff: workspace baseline at stage time vs current staged `merged_text` (git-style).',
        when='mechanical review of what changed for one pending path; prefer before bulk `read_staged_edit`.',
        not_=(
            'on-disk vs disk (use workspace diff elsewhere); full draft text '
            '(use `read_staged_edit` if diff truncated or need context).'
        ),
        shape=(
            f'`relative_path` {RELATIVE_PATH} new-file baseline is empty. '
            'Empty diff means baseline equals draft—re-read staged content or diagnostics.'
        ),
    ))
def diff_staged_edit_against_baseline(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
) -> str:

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


@tool(READ_STAGED_EDIT_NAME, description=describe(
        'Read a **window** of the pending staged merged draft for one path (temp file, not on-disk workspace).',
        when='inspect or copy exact staged text; revise after review; anchor line edits on the draft.',
        not_='on-disk checkpoint (use `read_workspace_file` after transfer or when no staging entry).',
        shape=(
            f'`relative_path` {RELATIVE_PATH} must exist in `list_staged_edits`. '
            f'`start_line`/`end_line` {ONE_BASED} over staged logical lines; window capped like `read_workspace_file`. '
            'Encoding is the staging entry’s disk encoding (no separate `encoding` arg). '
            f'{GUTTER}'
        ),
    ))
def read_staged_edit(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    start_line: Annotated[int, '1-based inclusive'] = 1,
    end_line: Annotated[int, '1-based inclusive'] = 220,
    include_line_numbers: Annotated[bool, 'false for raw lines / snippet matches'] = True,
) -> str:

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
    cap = _effective_max_file_read_lines()
    safe_start, safe_end = clamp_line_window(start_line, end_line, cap)
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


@tool(SEARCH_STAGED_EDITS_NAME, description=describe(
        'Grep **pending staging drafts** only (regex; tries ripgrep-style path then Python fallback).',
        when='pattern across staged files or one staged file (`relative_path` set).',
        not_='on-disk workspace (use `search_workspace`); discovery without staging (use `retrieve_workspace_semantic`).',
        shape='optional `relative_path` filters to that staged path; `max_matches` bounded.',
    ))
def search_staged_edits(
    query: str,
    relative_path: Annotated[str, 'workspace-relative POSIX path'] = '',
    max_matches: int = 20,
) -> str:

    sid = current_session_id.get()
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)
    try:
        pattern = re.compile(query, re.IGNORECASE)
    except re.error as exc:
        return (
            f'Tool error: invalid regex: {exc}. If you meant a literal string (not a pattern), escape regex '
            'metacharacters like ( ) [ ] { } . * + ? ^ $ | \\ or search a shorter, unambiguous substring instead.'
        )

    rel_filter = (relative_path or '').strip().replace('\\', '/')
    limit = max(1, min(int(max_matches), _effective_max_search_results()))
    matches: list[str] = []

    entries = _review_pending_entries(session)
    if rel_filter:
        entries = [(path, entry) for path, entry in entries if path == rel_filter]
        if not entries:
            return f'Tool error: no staged edit for `{rel_filter}`.'

    grep_matches = _search_staged_edits_grep(entries, query=query, limit=limit)
    # Empty list can mean parse/path remap failure — fall back to Python for tiny staging sets.
    if not grep_matches:
        matches = _search_staged_edits_python(entries, pattern=pattern, limit=limit)
    else:
        matches = grep_matches

    if not matches:
        return 'No matches found in staged edits.'
    return '\n'.join(matches)


@tool(FORMAT_STAGING_FILE_BLACK_NAME, description=describe(
        'Run Black on the **staged** `.py` draft in place (updates merged staging content).',
        when='staged Python draft has style/indent issues per diagnostics.',
        not_='arbitrary extensions (`.py` only); formatting workspace disk directly (transfer first or use workspace tools).',
        shape=f'`relative_path` {RELATIVE_PATH} then {VERIFY_LSP} or `read_staged_edit` to verify.',
    ))
def format_staging_file_black(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
) -> str:

    if not agent_formatters_enabled():
        return _FORMATTERS_DISABLED
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


@tool(FORMAT_STAGING_FILE_PRETTIER_NAME, description=describe(
        'Run Prettier on the **staged** draft in place (updates merged staging content).',
        when='staged `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.html`/`.htm`/`.css` draft has style issues per diagnostics.',
        not_='other extensions; formatting workspace disk directly (transfer first or use workspace tools).',
        shape=f'`relative_path` {RELATIVE_PATH} then {VERIFY_LSP} (for TS/JS) or `read_staged_edit` to verify.',
    ))
def format_staging_file_prettier(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
) -> str:

    if not agent_formatters_enabled():
        return _FORMATTERS_DISABLED
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


@tool(FORMAT_WORKSPACE_FILE_BLACK_NAME, description=describe(
        'Run Black on a workspace `.py` file in place (direct Editor + Auto-apply mode).',
        when='on-disk Python needs style fixes after a direct write.',
        not_='staged drafts (use `format_staging_file_black` when staging is active).',
        shape=f'{RELATIVE_PATH} then {VERIFY_LSP}.',
    ))
def format_workspace_file_black(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
) -> str:

    if not agent_formatters_enabled():
        return _FORMATTERS_DISABLED
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


@tool(FORMAT_WORKSPACE_FILE_PRETTIER_NAME, description=describe(
        'Run Prettier on a workspace file in place (direct Editor + Auto-apply mode).',
        when='on-disk `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.html`/`.htm`/`.css` needs style fixes.',
        not_='staged drafts (use `format_staging_file_prettier` when staging is active).',
        shape=f'{RELATIVE_PATH} then {VERIFY_LSP} for TS/JS.',
    ))
def format_workspace_file_prettier(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
) -> str:

    if not agent_formatters_enabled():
        return _FORMATTERS_DISABLED
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


def _overlay_combined_output(stdout: RollingTextBuffer, stderr: RollingTextBuffer) -> str:
    stdout_text = stdout.as_str()
    stderr_text = stderr.as_str()
    if stderr_text:
        return f'{stdout_text}\n[stderr]\n{stderr_text}' if stdout_text else f'[stderr]\n{stderr_text}'
    return stdout_text


@tool(RUN_STAGING_OVERLAY_COMMAND_NAME, description=describe(
        'Run `command_argv_json` (JSON argv array, no shell) in an ephemeral overlay: workspace + pending staged drafts.',
        when='pytest/npm tests against drafts without writing real workspace (requires Settings → Allow staging overlay commands).',
        not_='substitute for `transfer_staged_file_to_workspace`; real workspace unchanged until transfer/reject flow.',
        shape=(
            '`cwd_relative` optional under overlay root. Heavy dirs linked from workspace. '
            'Still finish review with transfer/reject. '
            'Allowed: test/build/lint runners only (pytest, python -m pytest, npm/pnpm/yarn run, etc.)—'
            'no shells, `python -c`, or `node -e`.'
        ),
    ))
async def run_staging_overlay_command(
    command_argv_json: Annotated[str, 'JSON argv array, no shell'],
    cwd_relative: str = '',
) -> str:

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
    argv, validate_err = validate_overlay_command_argv(argv)
    if argv is None:
        return validate_err
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
    stdout_buf = RollingTextBuffer()
    stderr_buf = RollingTextBuffer()
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
                start_new_session=True,
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
                capture=stdout_buf,
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
                capture=stderr_buf,
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
                    replay = _overlay_combined_output(stdout_buf, stderr_buf).strip()
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
                    float(CLARA_SUBPROCESS_TIMEOUT_SEC)
                    if CLARA_SUBPROCESS_TIMEOUT_SEC and CLARA_SUBPROCESS_TIMEOUT_SEC > 0
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
                    replay = _overlay_combined_output(stdout_buf, stderr_buf).strip()
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

        combined = _overlay_combined_output(stdout_buf, stderr_buf).strip()
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


def _apply_staged_transfer_auto(session: SessionState, rel_key: str, entry: object) -> str:
    """Auto-apply one staged path to the real workspace; returns a short status fragment."""
    if rel_key in session.test_run_materializations:
        _mark_materialization_approved(session, rel_key)
        out = (
            f'Staged `{rel_key}` is already saved in the workspace from the reviewer test run. '
            'Keeping the workspace copy as the approved version.'
        )
    else:
        root = get_active_workspace_root()
        target = (root / rel_key).resolve()
        try:
            write_file_resolved(
                target,
                str(entry.merged_text),  # type: ignore[attr-defined]
                str(entry.disk_encoding),  # type: ignore[attr-defined]
                'crlf' if entry.disk_newline == 'crlf' else 'lf',  # type: ignore[attr-defined]
            )
            emit_edit_journal(
                session,
                rel_key,
                str(entry.old_text),  # type: ignore[attr-defined]
                before_existed=bool(getattr(entry, 'before_existed', True)),
                encoding=str(entry.disk_encoding),  # type: ignore[attr-defined]
                newline='crlf' if entry.disk_newline == 'crlf' else 'lf',  # type: ignore[attr-defined]
            )
        except OSError as exc:
            return f'Tool error: could not write staged file `{rel_key}` into the workspace ({exc}).'
        except Exception as exc:
            return f'Tool error: could not encode staged file `{rel_key}` for the workspace ({exc}).'
        out = f'Approved staged `{rel_key}` into the real workspace.'
    entry.old_text = str(entry.merged_text)  # type: ignore[attr-defined]
    entry.workspace_applied = True  # type: ignore[attr-defined]
    logger.info('run_staged_transfer_to_workspace path=%s', rel_key)
    return out


def run_staged_transfer_batch(session: SessionState, paths: list[str]) -> str:
    """Transfer one or more staged paths to the real workspace (auto-apply or batch HITL)."""
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    validated, err = _validate_transfer_batch(session, paths)
    if err:
        return err

    if not session.auto_apply_mode:
        file_payloads: list[dict] = []
        any_test_run = False
        for rel_key in validated:
            entry = session.pending_edit_stagings[rel_key]
            payload, build_err = _build_staged_transfer_hitl_payload(session, rel_key, entry)
            if build_err:
                return f'Tool error: `{rel_key}`: {build_err}'
            file_payloads.append(payload)
            if rel_key in session.test_run_materializations:
                any_test_run = True
        request_id = uuid.uuid4().hex
        pending = PendingStagedTransferHitl(request_id=request_id, relative_paths=list(validated))
        session.pending_staged_transfer_hitl = pending
        session.pending_staged_transfer_batch_payload = staged_transfer_batch_sse_payload(pending, file_payloads)
        session.pending_diff_payload = None
        quoted = ', '.join(f'`{p}`' for p in validated)
        test_note = (
            ' Some paths are already on disk from reviewer test runs; confirm before this chain treats them as approved.'
            if any_test_run
            else ''
        )
        logger.info(
            'run_staged_transfer_batch awaiting hitl paths=%s count=%d',
            ','.join(validated),
            len(validated),
        )
        return (
            f'Staged {len(validated)} path(s) ({quoted}) ready to land in the real workspace; '
            f'**human confirmation** is required.{test_note} '
            'A batch diff card will appear in chat—approve or return each file for re-review. '
            'Stop this review turn after calling this tool.'
        )

    fragments: list[str] = []
    for rel_key in validated:
        entry = session.pending_edit_stagings[rel_key]
        fragment = _apply_staged_transfer_auto(session, rel_key, entry)
        if fragment.startswith('Tool error:'):
            return fragment
        fragments.append(fragment)
    lsp_section = _post_transfer_lsp_section(session, session_id=current_session_id.get())
    quoted = ', '.join(f'`{p}`' for p in validated)
    if len(validated) == 1:
        rel_key = validated[0]
        return (
            f'Transferred staged `{rel_key}` to the real workspace and kept the staged draft for the current chain. '
            f'{fragments[0]}{lsp_section} Stop this review turn after calling this tool.'
        )
    summary = '; '.join(fragments)
    return (
        f'Transferred {len(validated)} staged path(s) ({quoted}) to the real workspace. '
        f'{summary}{lsp_section} Stop this review turn after calling this tool.'
    )


def run_staged_transfer_to_workspace(session: SessionState, rel_key: str) -> str:
    """Apply the same path as :func:`transfer_staged_file_to_workspace` after a staging entry is present (tool or inline)."""
    return run_staged_transfer_batch(session, [rel_key.strip().replace('\\', '/')])


@tool(TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME, description=describe(
        'Approve landing staged draft(s): writes workspace (or queues HITL diff batch when auto-apply off).',
        when='draft(s) are correct and should become the on-disk checkpoint.',
        not_=(
            'request writer changes (use `reject_staged_workspace_edit` with feedback); '
            'abandon without landing (use `discard_staged_edits`); reading only (use `read_staged_edit`).'
        ),
        shape=(
            f'`relative_paths` is a non-empty list of {RELATIVE_PATH}s (preferred for multiple files). '
            'Legacy `relative_path` accepts a single path. After approval, follow-up reads use `read_workspace_file` / LSP on disk. '
            'Workspace LSP refresh runs **once** after every staged path in this chain is transferred (not after each file).'
        ),
    ))
def transfer_staged_file_to_workspace(
    relative_paths: Annotated[list[str], 'workspace-relative POSIX paths'] | None = None,
    relative_path: Annotated[str, 'workspace-relative POSIX path'] = '',
) -> str:

    paths, norm_err = _normalize_transfer_paths(relative_paths, relative_path)
    if norm_err:
        return norm_err
    assert paths is not None
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)
    return run_staged_transfer_batch(session, paths)


@tool(REJECT_STAGED_WORKSPACE_EDIT_NAME, description=describe(
        'Fail review: block transfer and return concrete `feedback` so the writer can revise the staged draft.',
        when='staged content is wrong, incomplete, or unsafe—needs another staging iteration.',
        not_=(
            'pass / ship (use `transfer_staged_file_to_workspace`); abandon without revising '
            '(use `discard_staged_edits`); generic praise without revision request.'
        ),
        shape=f'`relative_path` {RELATIVE_PATH} `feedback` must say what to fix.',
    ))
def reject_staged_workspace_edit(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    feedback: str,
) -> str:

    got = _get_staging_entry(relative_path)
    if isinstance(got, str):
        return got
    session, rel_key = got
    rollback_test_run_materializations(session)
    fb = (feedback or '').strip() or '(no details)'
    logger.info('reject_staged_workspace_edit path=%s', rel_key)
    return (
        f'Rejected staged edit for `{rel_key}`. Revise the existing staged draft in a follow-up turn '
        f'(same path), or call `discard_staged_edits` to abandon it. Orphaned staging is cleaned up '
        f'when the outer agent turn finishes.\n\n'
        f'Reviewer feedback:\n{fb}'
    )


@tool(DISCARD_STAGED_EDITS_NAME, description=describe(
        'Abandon pending staged draft(s): remove temp drafts and session entries without landing on disk.',
        when=(
            'draft(s) should not be transferred—wrong approach, superseded, or after user re-review '
            'when you will not revise.'
        ),
        not_=(
            'request revisions while keeping the draft (use `reject_staged_workspace_edit` with feedback); '
            'land approved work (use `transfer_staged_file_to_workspace`).'
        ),
        shape=(
            f'`relative_paths` is a non-empty list of {RELATIVE_PATH}s (preferred for multiple files). '
            'Legacy `relative_path` accepts a single path. Workspace on disk stays unchanged '
            '(test-run materializations for discarded paths are restored).'
        ),
    ))
def discard_staged_edits(
    relative_paths: Annotated[list[str], 'workspace-relative POSIX paths'] | None = None,
    relative_path: Annotated[str, 'workspace-relative POSIX path'] = '',
) -> str:

    paths, norm_err = _normalize_transfer_paths(relative_paths, relative_path)
    if norm_err:
        return norm_err
    assert paths is not None
    sid = current_session_id.get()
    if not sid:
        return 'Tool error: no active session.'
    blocked = mutation_tools_blocked_reason(sid)
    if blocked:
        return blocked
    session = get_session(sid)

    discarded: list[str] = []
    errors: list[str] = []
    for rel_key in paths:
        entry = session.pending_edit_stagings.get(rel_key)
        if not entry:
            errors.append(f'no staged edit for `{rel_key}`')
            continue
        if _entry_workspace_applied(entry):
            errors.append(
                f'staged `{rel_key}` is already approved in the workspace for this chain '
                '(no longer pending review)'
            )
            continue
        try:
            restore_materialized_path(session, rel_key)
        except Exception as exc:
            logger.warning('discard_staged_edits restore materialization failed path=%s err=%s', rel_key, exc)
        if not edit_staging.discard_session_staging(session, rel_key):
            errors.append(f'no staged edit for `{rel_key}`')
            continue
        discarded.append(rel_key)
        logger.info('discard_staged_edits path=%s', rel_key)

    if errors and not discarded:
        return 'Tool error: ' + '; '.join(errors) + '.'
    quoted = ', '.join(f'`{p}`' for p in discarded)
    if len(discarded) == 1:
        body = f'Discarded staged draft for {quoted}. Workspace on disk was not changed.'
    else:
        body = f'Discarded {len(discarded)} staged draft(s) ({quoted}). Workspace on disk was not changed.'
    if errors:
        body += ' Partial failures: ' + '; '.join(errors) + '.'
    return body


def staging_review_tools(*, direct: bool = False) -> tuple[list[object], dict[str, object]]:
    formatters_on = agent_formatters_enabled()
    if direct:
        tools: list[object] = [lsp_get_diagnostics]
        if formatters_on:
            tools.extend([format_workspace_file_black, format_workspace_file_prettier])
        tools.append(run_staging_overlay_command)
    else:
        tools = [
            list_staged_edits,
            diff_staged_edit_against_baseline,
            read_staged_edit,
            search_staged_edits,
            lsp_get_diagnostics,
        ]
        if formatters_on:
            tools.extend([format_staging_file_black, format_staging_file_prettier])
        tools.extend(
            [
                run_staging_overlay_command,
                transfer_staged_file_to_workspace,
                reject_staged_workspace_edit,
                discard_staged_edits,
            ]
        )
    m = {t.name: t for t in tools}
    return tools, m
