"""Dedicated staging tools for create/update specialists and the outer agent when Editor is on.

All supported text paths are staged under ``CLARA_STAGING_DIR`` before the workspace updates. The on-disk workspace
stays the checkpoint until ``transfer_staged_file_to_workspace`` (or auto-apply) lands the draft.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated, Any

from langchain_core.tools import tool

from clara_coder_backend.staging import edit_staging as _edit_staging
from clara_coder_backend.domain import EditStagingEntry, SessionState
from clara_coder_backend.tools.edit import _finalize_workspace_edit, _tool_encoding_param, _tool_newline_param
from clara_coder_backend.tools.tool_conventions import ENCODING_NEWLINE, ONE_BASED, RELATIVE_PATH, STAGE_LAND, describe
from clara_coder_backend.lsp.diagnostics import post_edit_checks_footer
from clara_coder_backend.lsp.file_policy import is_lsp_managed_path, is_prettier_managed_path, lsp_server_for_path
from clara_coder_backend.lsp.manager import sync_session_document
from clara_coder_backend.staging.partial_workspace_edit import (
    line_range_edit_tool_feedback,
    merge_partial_edit,
    snippet_unique_on_text,
)
from clara_coder_backend.session.state import agent_formatters_enabled, current_session_id, mutation_tools_blocked_reason
from clara_coder_backend.workspace.workspace_text_io import (
    DiskNewline,
    NewlineMode,
    decode_for_tools,
    resolve_newline_for_write,
    validate_workspace_encoding,
    write_file_resolved,
)
from clara_coder_backend.session.file_journal import emit_edit_journal
from clara_coder_backend.config import CLARA_WRITE_JOB_DEFAULT_WAIT_SEC
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path, truncate_text_head_tail
from clara_coder_backend.tools.write_jobs import (
    PHASE_FORMATTING,
    PHASE_LSP,
    PHASE_WRITING,
    WriteJob,
    start_or_reuse_write_job,
    wait_write_job_sync,
)

logger = logging.getLogger('clara.staging')

STAGE_CREATE_FILE_NAME = 'stage_create_file'
STAGE_WORKSPACE_FILE_OVERWRITE_NAME = 'stage_workspace_file_overwrite'
STAGE_LINE_RANGE_EDIT_NAME = 'stage_line_range_edit'
STAGE_SNIPPET_EDIT_NAME = 'stage_snippet_edit'

__all__ = [
    'stage_create_file',
    'stage_workspace_file_overwrite',
    'stage_line_range_edit',
    'stage_snippet_edit',
    'STAGING_TOOLS',
    'STAGE_CREATE_FILE_NAME',
    'STAGE_WORKSPACE_FILE_OVERWRITE_NAME',
    'STAGE_LINE_RANGE_EDIT_NAME',
    'STAGE_SNIPPET_EDIT_NAME',
]


def _existing_staging_entry(session: SessionState, rel_display: str) -> EditStagingEntry | None:
    entry = session.pending_edit_stagings.get(rel_display)
    return entry if isinstance(entry, EditStagingEntry) else None


def _staging_edit_preamble(
    relative_path: str,
    *,
    disk_encoding: str,
    newline_mode: NewlineMode,
) -> tuple[SessionState, str, str, str, DiskNewline, bool] | str:
    session_id = current_session_id.get()
    if not session_id:
        return 'Tool error: no active session.'

    from clara_coder_backend.session.state import get_session

    session = get_session(session_id)
    # Do not clobber an in-flight staged-transfer / diff HITL pause (another tool round could run next).
    if session.agent_pause_event is None:
        session.pending_diff_payload = None
        session.pending_staged_transfer_hitl = None
        session.pending_staged_transfer_batch_payload = None

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    rel_display = target.relative_to(root).as_posix()
    before_existed = target.is_file()

    source = target

    raw_existing: bytes | None = None
    old_text = ''
    if source.is_file():
        try:
            raw_existing = source.read_bytes()
            old_text = decode_for_tools(raw_existing, disk_encoding)
        except OSError as exc:
            return f'Tool error: could not read file ({exc}).'

    disk_nl = resolve_newline_for_write(newline_mode, path=source, raw_existing=raw_existing)
    return session, rel_display, old_text, disk_encoding, disk_nl, before_existed


def _allocate_in_progress_staging_file(
    session_id: str,
    rel_display: str,
    graph_id: str,
    job_id: str,
) -> Path:
    """Unique in-progress temp so a cancel cannot clobber the prior committed draft."""
    base = _edit_staging.allocate_staging_file(session_id, rel_display, graph_id=graph_id)
    return base.with_name(f'{base.name}.{job_id}')


def _format_staged_success(
    rel_display: str,
    mode: str,
    *,
    had_prior_staging: bool,
    diagnostics_note: str,
) -> str:
    action = 'Updated staged draft' if had_prior_staging else 'Staged'
    next_partial = ''
    if mode == 'snippet':
        next_partial = (
            ' **Next partial edit on this path:** refresh anchors from `read_staged_edit` '
            '(draft plane)—do not reuse `old_snippet` from `read_workspace_file` or memory.'
        )
    return (
        f'{action} `{rel_display}` for review. The draft is **already on disk**; a journal of the pre-stage '
        f'bytes is kept until `transfer_staged_file_to_workspace` (keep) or `discard_staged_edits` (restore). '
        f'`read_workspace_file` and `read_staged_edit` show the same current text. '
        f'Inspect with `diff_staged_edit_against_baseline` and/or `read_staged_edit`.{next_partial} '
        f'**Next:** review then call '
        f'`transfer_staged_file_to_workspace` to keep, `reject_staged_workspace_edit` to send back, or '
        f'`discard_staged_edits` to restore the journal; '
        f'Use staging review tools (`list_staged_edits`, `diff_staged_edit_against_baseline`, `read_staged_edit`, '
        f'`search_staged_edits`) when you need a formal review pass before keep/restore.'
        f'{diagnostics_note}'
    )


def _format_merged_in_memory(
    rel_display: str,
    merged: str,
    disk_encoding: str,
) -> tuple[str, list[str]]:
    """Format ``merged`` in memory (Black / Prettier). Returns ``(text, formatter_lines)``."""

    formatter_lines: list[str] = []
    if not agent_formatters_enabled():
        formatter_lines.append(
            'Formatter: skipped (Black and Prettier are disabled in Settings → Tools).'
        )
        return merged, formatter_lines
    if rel_display.lower().endswith('.py'):
        fmt, err = _edit_staging.format_python_source_str(merged)
        logger.info('black path=%s ok=%s detail=%s', rel_display, fmt is not None, err)
        if fmt is not None:
            formatter_lines.append('Formatter (Black): applied to the staged draft.')
            return fmt, formatter_lines
        formatter_lines.append(f'Formatter (Black): draft unchanged ({err}).')
        return merged, formatter_lines
    if is_prettier_managed_path(rel_display):
        ws_root = get_active_workspace_root()
        fmt, err = _edit_staging.format_source_via_prettier(
            merged,
            workspace_root=ws_root,
            relative_posix=rel_display,
            source_encoding=disk_encoding or 'utf-8',
        )
        logger.info('prettier path=%s ok=%s detail=%s', rel_display, fmt is not None, err)
        if fmt is not None:
            formatter_lines.append('Formatter (Prettier): applied to the staged draft.')
            return fmt, formatter_lines
        formatter_lines.append(f'Formatter (Prettier): draft unchanged ({err}).')
        return merged, formatter_lines
    formatter_lines.append(
        'Formatter: automatic Black applies only to `.py` drafts; Prettier applies only to `.ts`, `.tsx`, `.js`, '
        '`.jsx`, `.mjs`, `.cjs`, `.html`, `.htm`, `.css` drafts.'
    )
    return merged, formatter_lines


def _run_staging_lsp(
    session_id: str,
    rel_display: str,
    disk_encoding: str,
    formatter_lines: list[str],
    text: str,
) -> str:
    srv = lsp_server_for_path(rel_display)
    if is_lsp_managed_path(rel_display) and srv:
        try:
            diagnostics = sync_session_document(
                rel_display,
                text,
                session_id=session_id,
                scope='workspace',
            )
            logger.info('%s LSP sync path=%s diagnostics=%s', srv, rel_display, len(diagnostics))
            return truncate_text_head_tail(
                post_edit_checks_footer(
                    rel_display,
                    diagnostics,
                    lsp_scope='workspace',
                    server_kind=srv,
                    formatter_lines=formatter_lines,
                ),
                14_000,
            )
        except Exception as exc:
            logger.warning('%s LSP sync failed path=%s err=%s', srv, rel_display, exc)
            return truncate_text_head_tail(
                '\n---\nPost-edit checks:\n'
                + '\n'.join(formatter_lines)
                + f'\nLSP sync failed: {exc}.',
                14_000,
            )
    if formatter_lines:
        return '\n---\nPost-edit checks:\n' + '\n'.join(formatter_lines)
    return ''


def execute_staging_write_job(job: WriteJob) -> str:
    """Job runner: format in memory, write the real file, journal, then workspace LSP. Does not land."""
    token = current_session_id.set(job.session_id)
    try:
        return _execute_staging_write_job(job)
    finally:
        current_session_id.reset(token)


def _execute_staging_write_job(job: WriteJob) -> str:
    from clara_coder_backend.session.state import get_session

    payload = job.payload
    session = get_session(job.session_id)
    rel_display = job.rel_display
    original_old_text = str(payload.get('original_old_text') or '')
    merged = str(payload.get('merged') or '')
    mode = str(payload.get('mode') or 'full-file')
    disk_encoding = str(payload.get('disk_encoding') or 'utf-8')
    disk_newline: DiskNewline = 'crlf' if payload.get('disk_newline') == 'crlf' else 'lf'
    before_existed = bool(payload.get('before_existed', True))
    had_prior_staging = bool(payload.get('had_prior_staging', False))

    if job.cancel_requested:
        return f'Tool error: write job `{job.job_id}` was cancelled.'

    job.phase = PHASE_FORMATTING
    merged_out, formatter_lines = _format_merged_in_memory(rel_display, merged, disk_encoding)

    if job.cancel_requested:
        return f'Tool error: write job `{job.job_id}` was cancelled.'

    job.phase = PHASE_WRITING
    with job.commit_lock:
        if job.cancel_requested:
            return f'Tool error: write job `{job.job_id}` was cancelled.'
        prior = session.pending_edit_stagings.get(rel_display)
        journal_old = prior.old_text if prior else original_old_text
        journal_existed = prior.before_existed if prior else before_existed
        journal_enc = prior.disk_encoding if prior else disk_encoding
        journal_nl: DiskNewline = (
            ('crlf' if prior.disk_newline == 'crlf' else 'lf') if prior else disk_newline
        )
        try:
            root = get_active_workspace_root()
            target = normalize_relative_path(root, rel_display)
            write_file_resolved(target, merged_out, journal_enc, journal_nl)
        except OSError as exc:
            return f'Tool error: could not write workspace file ({exc}).'
        except Exception as exc:
            return f'Tool error: could not encode workspace file ({exc}).'
        if prior is None:
            emit_edit_journal(
                session,
                rel_display,
                journal_old,
                before_existed=journal_existed,
                encoding=journal_enc,
                newline=journal_nl,
            )
        session.pending_edit_stagings[rel_display] = EditStagingEntry(
            temp_path='',
            old_text=journal_old,
            merged_text=merged_out,
            disk_encoding=journal_enc,
            disk_newline=journal_nl,
            edit_mode=mode,
            workspace_applied=False,
            before_existed=journal_existed,
        )
        job.committed = True

    job.phase = PHASE_LSP
    diagnostics_note = _run_staging_lsp(
        job.session_id,
        rel_display,
        disk_encoding,
        formatter_lines,
        merged_out,
    )

    logger.info('staged for review path=%s job=%s', rel_display, job.job_id)
    return _format_staged_success(
        rel_display,
        mode,
        had_prior_staging=had_prior_staging,
        diagnostics_note=diagnostics_note,
    )


def _dispatch_staging_write(
    session: SessionState,
    session_id: str,
    rel_display: str,
    original_old_text: str,
    merged: str,
    mode: str,
    disk_encoding: str,
    disk_newline: DiskNewline,
    *,
    before_existed: bool,
    staging_seed_text: str | None = None,
    land_in_workspace: bool = False,
    extra_footer: str = '',
    tool_name: str = STAGE_CREATE_FILE_NAME,
    wait_seconds: float | None = None,
) -> str:
    """Start or reuse a write job, wait the default window, then report (land only if the job finished)."""
    job, reused = start_or_reuse_write_job(
        session_id=session_id,
        rel_display=rel_display,
        tool_name=tool_name,
        land_in_workspace=land_in_workspace,
        runner=execute_staging_write_job,
        payload={
            'original_old_text': original_old_text,
            'merged': merged,
            'mode': mode,
            'disk_encoding': disk_encoding,
            'disk_newline': disk_newline,
            'before_existed': before_existed,
            'staging_seed_text': staging_seed_text,
            'had_prior_staging': rel_display in session.pending_edit_stagings,
        },
        extra_footer=extra_footer,
    )
    wait_sec = CLARA_WRITE_JOB_DEFAULT_WAIT_SEC if wait_seconds is None else float(wait_seconds)
    return wait_write_job_sync(job, wait_sec, reused=reused)


def _staging_after_merge(
    session: SessionState,
    rel_display: str,
    original_old_text: str,
    merged: str,
    mode: str,
    disk_encoding: str,
    disk_newline: DiskNewline,
    *,
    before_existed: bool,
    staging_seed_text: str | None = None,
    land_in_workspace: bool = False,
    extra_footer: str = '',
    tool_name: str = STAGE_CREATE_FILE_NAME,
) -> str:
    """Stage merged content via a write job (or finalize immediately when there is no session)."""
    session_id = current_session_id.get()
    if not session_id:
        return _finalize_workspace_edit(
            session,
            rel_display,
            original_old_text,
            merged,
            mode,
            disk_encoding,
            disk_newline,
            before_existed=before_existed,
        )
    return _dispatch_staging_write(
        session,
        session_id,
        rel_display,
        original_old_text,
        merged,
        mode,
        disk_encoding,
        disk_newline,
        before_existed=before_existed,
        staging_seed_text=staging_seed_text,
        land_in_workspace=land_in_workspace,
        extra_footer=extra_footer,
        tool_name=tool_name,
    )


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
    land_in_workspace: bool = False,
    tool_name: str = STAGE_CREATE_FILE_NAME,
) -> str:
    """Shared body for staging tools: validate, read, merge, then start or reuse a write job."""
    blocked = mutation_tools_blocked_reason()
    if blocked:
        return blocked
    try:
        enc = _tool_encoding_param(encoding)
        nm = _tool_newline_param(newline)
    except ValueError as exc:
        return f'Tool error: {exc}'

    pre = _staging_edit_preamble(relative_path, disk_encoding=enc, newline_mode=nm)
    if isinstance(pre, str):
        return pre
    session, rel_display, workspace_old_text, disk_enc, disk_nl, before_existed = pre
    prior = _existing_staging_entry(session, rel_display)
    base_text = workspace_old_text
    original_old_text = workspace_old_text
    if prior:
        base_text = str(prior.merged_text or '')
        original_old_text = prior.old_text
        before_existed = prior.before_existed
        disk_enc = prior.disk_encoding
        disk_nl = 'crlf' if prior.disk_newline == 'crlf' else 'lf'

    merged, merge_err = merge_partial_edit(
        base_text,
        new_content=new_content,
        old_snippet=old_snippet,
        new_snippet=new_snippet,
        start_line=start_line,
        end_line=end_line,
    )
    if merge_err:
        if prior:
            disk_vs_draft = ''
            if mode == 'snippet' and old_snippet and snippet_unique_on_text(
                workspace_old_text, old_snippet
            ) and old_snippet not in base_text:
                disk_vs_draft = (
                    ' Your `old_snippet` matches the **on-disk** file uniquely but is **absent from the '
                    'staged draft**—a prior stage on this path already changed or moved that text. '
                )
            return (
                f'Tool error: {merge_err} `{rel_display}` already has a **pending journal**—this search ran '
                'against the current draft (already on disk).'
                f'{disk_vs_draft}'
                ' If a prior edit on this path already changed or moved those lines, your anchor/line '
                'numbers are stale. Call `read_workspace_file` or `read_staged_edit` on this path to see the '
                'draft as it stands right now, then retry with anchors/line numbers taken from that output.'
            )
        return f'Tool error: {merge_err}'
    assert merged is not None

    extra_footer = ''
    if mode == 'line-range' and start_line > 0 and end_line >= start_line:
        extra_footer = line_range_edit_tool_feedback(base_text, start_line, end_line, new_snippet)
    return _staging_after_merge(
        session,
        rel_display,
        original_old_text,
        merged,
        mode,
        disk_enc,
        disk_nl,
        before_existed=before_existed,
        staging_seed_text=workspace_old_text,
        land_in_workspace=land_in_workspace,
        extra_footer=extra_footer,
        tool_name=tool_name,
    )


@tool(STAGE_CREATE_FILE_NAME, description=describe(
        'Stage a **new** file (or full replacement treated as create flow): writes the real workspace file and journals the pre-stage bytes.',
        when='path should not rely on existing workspace bytes as old_text baseline in the same way as overwrite (new file or create flow).',
        not_='read on-disk truth for an existing path before edit (use `read_workspace_file` first); inspect draft (use `read_staged_edit` / diff after).',
        shape=(
            f'`relative_path` {RELATIVE_PATH} {ENCODING_NEWLINE} Parents created on transfer. '
            f'{STAGE_LAND} Keep false in nested file-write author — code review should run first.'
        ),
    ))
def stage_create_file(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: Annotated[str, 'lf|crlf|preserve (empty = Settings default)'] = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='full-file',
        new_content=new_content or '',
        land_in_workspace=land_in_workspace,
        tool_name=STAGE_CREATE_FILE_NAME,
    )


@tool(STAGE_WORKSPACE_FILE_OVERWRITE_NAME, description=describe(
        'Stage a **full-file** replace: seeds from workspace (or prior draft), writes the real file, and journals the first pre-stage bytes.',
        when='file exists on disk or a staged draft already exists for this path and you have full revised contents.',
        not_='new path with no disk file and no prior staging (use `stage_create_file`); partial edits (use `stage_line_range_edit` / `stage_snippet_edit`).',
        shape=f'same {ENCODING_NEWLINE} {RELATIVE_PATH} rules as `stage_create_file`. {STAGE_LAND}',
    ))
def stage_workspace_file_overwrite(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    new_content: str,
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: Annotated[str, 'lf|crlf|preserve (empty = Settings default)'] = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    blocked = mutation_tools_blocked_reason()
    if blocked:
        return blocked
    try:
        enc = validate_workspace_encoding(_tool_encoding_param(encoding))
        nm = _tool_newline_param(newline)
    except ValueError as exc:
        return f'Tool error: {exc}'

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    pre = _staging_edit_preamble(relative_path, disk_encoding=enc, newline_mode=nm)
    if isinstance(pre, str):
        return pre
    session, rel_display, workspace_old_text, disk_enc, disk_nl, before_existed = pre
    prior = _existing_staging_entry(session, rel_display)
    if not target.is_file() and prior is None:
        return (
            f'Tool error: `{target.relative_to(root).as_posix()}` does not exist in the workspace. '
            'Use `stage_create_file` for new files unless an existing staged draft for this path should be revised.'
        )
    if prior is not None:
        disk_enc = prior.disk_encoding
        disk_nl = 'crlf' if prior.disk_newline == 'crlf' else 'lf'
        original_old_text = prior.old_text
        before_existed = prior.before_existed
        staging_seed_text = prior.merged_text
    else:
        original_old_text = workspace_old_text
        staging_seed_text = workspace_old_text
    return _staging_after_merge(
        session,
        rel_display,
        original_old_text,
        new_content or '',
        'full-file',
        disk_enc,
        disk_nl,
        before_existed=before_existed,
        staging_seed_text=staging_seed_text,
        land_in_workspace=land_in_workspace,
        tool_name=STAGE_WORKSPACE_FILE_OVERWRITE_NAME,
    )


@tool(STAGE_LINE_RANGE_EDIT_NAME, description=describe(
        'Stage replacement of an inclusive **1-based** line range with `new_snippet` (merged, then written through to disk).',
        when='localized edit; keep diff small. `new_snippet` may be empty to delete lines. If `new_snippet` empty, `new_content` is used (LM alias).',
        not_='new file (use `stage_create_file`); unique match by context (prefer `stage_snippet_edit`). Append: `start_line=end_line=n+1` after last line; seed empty: `1,1`.',
        shape=(
            f'line numbers align with `read_workspace_file` / `read_staged_edit` gutters on the text you matched ({ONE_BASED}). '
            f'Footer in tool output has column/UTF-16 detail for follow-ups. {ENCODING_NEWLINE} {STAGE_LAND}'
        ),
    ))
def stage_line_range_edit(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    start_line: Annotated[int, '1-based inclusive'],
    end_line: Annotated[int, '1-based inclusive'],
    new_snippet: Annotated[str, 'replacement text; empty deletes'] = '',
    new_content: str = '',
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: Annotated[str, 'lf|crlf|preserve (empty = Settings default)'] = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    ns = '' if new_snippet is None else new_snippet
    nc = '' if new_content is None else new_content
    snippet = ns if ns != '' else nc
    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='line-range',
        new_snippet=snippet,
        start_line=int(start_line) if start_line else 0,
        end_line=int(end_line) if end_line else 0,
        land_in_workspace=land_in_workspace,
        tool_name=STAGE_LINE_RANGE_EDIT_NAME,
    )


@tool(STAGE_SNIPPET_EDIT_NAME, description=describe(
        'Stage a single unique `old_snippet` → `new_snippet` replace in the staging/workspace merge base '
        '(draft if one exists for the path, else on-disk file).',
        when=(
            'you have unique multi-line raw context copied with `include_line_numbers=false`. '
            'Match must be unique (exact, CRLF-normalized, trailing-whitespace-tolerant, then gated fuzzy). '
            'If `new_snippet` is empty, `new_content` is used (LM alias).'
        ),
        not_=(
            'you already know line numbers from a numbered read—prefer `stage_line_range_edit` instead; '
            'paste numbered gutters into `old_snippet` (use `include_line_numbers=false` or line-range).'
        ),
        shape=(
            f'After the first stage on a path, refresh `old_snippet` from `read_workspace_file` or '
            f'`read_staged_edit`. {ENCODING_NEWLINE} {RELATIVE_PATH} {STAGE_LAND}'
        ),
    ))
def stage_snippet_edit(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    old_snippet: Annotated[str, 'unique raw anchor; no line-number gutters'],
    new_snippet: Annotated[str, 'replacement text; empty deletes'] = '',
    new_content: Annotated[str, 'LM alias used when new_snippet is empty'] = '',
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: Annotated[str, 'lf|crlf|preserve (empty = Settings default)'] = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    ns = '' if new_snippet is None else new_snippet
    nc = '' if new_content is None else new_content
    snippet = ns if ns != '' else nc
    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='snippet',
        old_snippet=old_snippet or '',
        new_snippet=snippet,
        land_in_workspace=land_in_workspace,
        tool_name=STAGE_SNIPPET_EDIT_NAME,
    )


STAGING_TOOLS: list[Any] = [
    stage_create_file,
    stage_workspace_file_overwrite,
    stage_line_range_edit,
    stage_snippet_edit,
]
