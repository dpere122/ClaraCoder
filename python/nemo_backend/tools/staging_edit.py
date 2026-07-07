"""Dedicated staging tools for create/update specialists and the outer agent when Editor is on.

All supported text paths are staged under ``NEMO_STAGING_DIR`` before the workspace updates. The on-disk workspace
stays the checkpoint until ``transfer_staged_file_to_workspace`` (or auto-apply) lands the draft.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated, Any

from langchain_core.tools import tool

from nemo_backend import edit_staging as _edit_staging
from nemo_backend.domain import EditStagingEntry, SessionState
from nemo_backend.tools.edit import _finalize_workspace_edit, _tool_encoding_param, _tool_newline_param
from nemo_backend.tools.tool_conventions import ENCODING_NEWLINE, ONE_BASED, RELATIVE_PATH, STAGE_LAND, describe
from nemo_backend.lsp.diagnostics import post_edit_checks_footer
from nemo_backend.lsp.file_policy import is_lsp_managed_path, is_prettier_managed_path, lsp_server_for_path
from nemo_backend.lsp.manager import get_session_lsp_manager
from nemo_backend.partial_workspace_edit import line_range_edit_tool_feedback, merge_partial_edit
from nemo_backend.state import current_session_id, mutation_tools_blocked_reason
from nemo_backend.workspace_text_io import (
    DiskNewline,
    NewlineMode,
    decode_for_tools,
    resolve_newline_for_write,
    validate_workspace_encoding,
)
from nemo_backend.tools.workspace import get_active_workspace_root, normalize_relative_path, truncate_text_head_tail

logger = logging.getLogger('nemo.staging')

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
) -> tuple[SessionState, str, str, str, DiskNewline] | str:
    session_id = current_session_id.get()
    if not session_id:
        return 'Tool error: no active session.'

    from nemo_backend.state import get_session

    session = get_session(session_id)
    # Do not clobber an in-flight staged-transfer / diff HITL pause (another tool round could run next).
    if session.agent_pause_event is None:
        session.pending_diff_payload = None
        session.pending_staged_transfer_hitl = None
        session.pending_staged_transfer_batch_payload = None

    root = get_active_workspace_root()
    target = normalize_relative_path(root, relative_path)
    rel_display = target.relative_to(root).as_posix()

    source_root = _edit_staging.get_active_staging_snapshot_root(session) or root
    source = normalize_relative_path(source_root, rel_display)
    if not source.exists() and target.exists():
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
    return session, rel_display, old_text, disk_encoding, disk_nl


def _staging_after_merge(
    session: SessionState,
    rel_display: str,
    original_old_text: str,
    merged: str,
    mode: str,
    disk_encoding: str,
    disk_newline: DiskNewline,
    *,
    staging_seed_text: str | None = None,
    land_in_workspace: bool = False,
) -> str:
    """Write merged content to staging (all path kinds use the same staging → review → transfer flow)."""
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
        )

    had_prior_staging = rel_display in session.pending_edit_stagings
    prior = session.pending_edit_stagings.pop(rel_display, None)
    if prior:
        _edit_staging.unlink_staging_quiet(Path(prior.temp_path))

    temp_path = _edit_staging.allocate_staging_file(
        session_id,
        rel_display,
        graph_id=session.active_staging_snapshot_id,
    )
    try:
        if staging_seed_text is not None:
            _edit_staging.write_staging_text(temp_path, staging_seed_text, disk_encoding, disk_newline)
        _edit_staging.write_staging_text(temp_path, merged, disk_encoding, disk_newline)
    except OSError as exc:
        return f'Tool error: could not write staging file ({exc}).'

    formatter_lines: list[str] = []
    if rel_display.lower().endswith('.py'):
        ok, detail = _edit_staging.run_black_on_file(temp_path, encoding=disk_encoding, disk_newline=disk_newline)
        logger.info('black path=%s ok=%s detail=%s', rel_display, ok, detail)
        if ok:
            formatter_lines.append('Formatter (Black): applied to the staged draft.')
        else:
            formatter_lines.append(f'Formatter (Black): draft unchanged ({detail}).')
    elif is_prettier_managed_path(rel_display):
        ws_root = get_active_workspace_root()
        ok, detail = _edit_staging.run_prettier_on_file(
            temp_path,
            workspace_root=ws_root,
            relative_posix=rel_display,
            encoding=disk_encoding,
            disk_newline=disk_newline,
        )
        logger.info('prettier path=%s ok=%s detail=%s', rel_display, ok, detail)
        if ok:
            formatter_lines.append('Formatter (Prettier): applied to the staged draft.')
        else:
            formatter_lines.append(f'Formatter (Prettier): draft unchanged ({detail}).')
    else:
        formatter_lines.append(
            'Formatter: automatic Black applies only to `.py` drafts; Prettier applies only to `.ts`, `.tsx`, `.js`, '
            '`.jsx`, `.mjs`, `.cjs`, `.html`, `.htm`, `.css` drafts.'
        )

    try:
        merged_out = _edit_staging.read_staging_text(temp_path, disk_encoding)
    except OSError as exc:
        return f'Tool error: could not read staging file ({exc}).'
    _edit_staging.write_snapshot_file(session, rel_display, merged_out, disk_encoding, disk_newline)

    session.pending_edit_stagings[rel_display] = EditStagingEntry(
        temp_path=str(temp_path),
        old_text=original_old_text,
        merged_text=merged_out,
        disk_encoding=disk_encoding,
        disk_newline=disk_newline,
        edit_mode=mode,
        workspace_applied=False,
    )

    diagnostics_note = ''
    diagnostics: list[dict[str, Any]] = []
    srv = lsp_server_for_path(rel_display)
    if is_lsp_managed_path(rel_display) and srv:
        try:
            enc_lsp = validate_workspace_encoding(disk_encoding or 'utf-8')
            lsp_manager = get_session_lsp_manager(session_id, scope='staging', server=srv)
            diagnostics = lsp_manager.sync_workspace_document(rel_display, encoding=enc_lsp)
            logger.info('%s LSP sync path=%s diagnostics=%s', srv, rel_display, len(diagnostics))
            diagnostics_note = truncate_text_head_tail(
                post_edit_checks_footer(
                    rel_display,
                    diagnostics,
                    lsp_scope='staging',
                    server_kind=srv,
                    formatter_lines=formatter_lines,
                ),
                14_000,
            )
        except Exception as exc:
            logger.warning('%s LSP sync failed path=%s err=%s', srv, rel_display, exc)
            diagnostics_note = truncate_text_head_tail(
                '\n---\nPost-edit checks:\n'
                + '\n'.join(formatter_lines)
                + f'\nLSP sync failed: {exc}.',
                14_000,
            )
    elif formatter_lines:
        diagnostics_note = '\n---\nPost-edit checks:\n' + '\n'.join(formatter_lines)

    logger.info('staged for review path=%s', rel_display)
    action = 'Updated staged draft' if had_prior_staging else 'Staged'
    if land_in_workspace:
        from nemo_backend.tools import review_tools as _review_tools

        return (
            f'{action} `{rel_display}` for review.{diagnostics_note}\n\n'
            f'---\n\n{_review_tools.run_staged_transfer_to_workspace(session, rel_display)}'
        )
    return (
        f'{action} `{rel_display}` for review. The workspace file on disk is **unchanged** until '
        f'`transfer_staged_file_to_workspace` succeeds. Inspect the draft with `diff_staged_edit_against_baseline` '
        f'and/or `read_staged_edit` (not `read_workspace_file` for new staged content). **Next:** review then call '
        f'`transfer_staged_file_to_workspace` or `reject_staged_workspace_edit` yourself; '
        f'Use staging review tools (`list_staged_edits`, `diff_staged_edit_against_baseline`, `read_staged_edit`, '
        f'`search_staged_edits`) when you need a formal review pass before transfer.'
        f'{diagnostics_note}'
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
) -> str:
    """Shared body for staging tools: validate, read, merge, then stage or finalize."""
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
    session, rel_display, workspace_old_text, disk_enc, disk_nl = pre
    prior = _existing_staging_entry(session, rel_display)
    base_text = workspace_old_text
    original_old_text = workspace_old_text
    if prior:
        try:
            base_text = _edit_staging.read_staging_text(Path(prior.temp_path), prior.disk_encoding)
        except OSError as exc:
            return f'Tool error: could not read existing staged draft ({exc}).'
        original_old_text = prior.old_text
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
        return f'Tool error: {merge_err}'
    assert merged is not None

    out = _staging_after_merge(
        session,
        rel_display,
        original_old_text,
        merged,
        mode,
        disk_enc,
        disk_nl,
        staging_seed_text=workspace_old_text,
        land_in_workspace=land_in_workspace,
    )
    if mode == 'line-range' and start_line > 0 and end_line >= start_line:
        out += line_range_edit_tool_feedback(base_text, start_line, end_line, new_snippet)
    return out


@tool(STAGE_CREATE_FILE_NAME, description=describe(
        'Stage a **new** file (or full replacement treated as create flow): merged content goes to review, disk unchanged until transfer.',
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
    )


@tool(STAGE_WORKSPACE_FILE_OVERWRITE_NAME, description=describe(
        'Stage a **full-file** replace: seeds from workspace (or prior staged draft), writes merged draft to staging; disk unchanged until transfer.',
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
    session, rel_display, workspace_old_text, disk_enc, disk_nl = pre
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
        staging_seed_text=staging_seed_text,
        land_in_workspace=land_in_workspace,
    )


@tool(STAGE_LINE_RANGE_EDIT_NAME, description=describe(
        'Stage replacement of an inclusive **1-based** line range with `new_snippet` (merged into staging copy).',
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
    )


@tool(STAGE_SNIPPET_EDIT_NAME, description=describe(
        'Stage a single unique `old_snippet` → `new_snippet` replace in the staging/workspace merge base.',
        when='change anchored by surrounding context; match must be unique (exact, CRLF-normalized, then gated fuzzy).',
        not_='paste numbered gutters from `read_workspace_file`/`read_staged_edit` into `old_snippet` (use `include_line_numbers=false` or line-range edit).',
        shape=f'{ENCODING_NEWLINE} {RELATIVE_PATH} {STAGE_LAND}',
    ))
def stage_snippet_edit(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    old_snippet: Annotated[str, 'unique anchor; no line-number gutters'],
    new_snippet: Annotated[str, 'replacement text; empty deletes'] = '',
    encoding: Annotated[str, 'empty = Settings default'] = '',
    newline: Annotated[str, 'lf|crlf|preserve (empty = Settings default)'] = '',
    land_in_workspace: Annotated[bool, 'false while iterating; true on final call to land in one step'] = False,
) -> str:

    return _run_staging_tool(
        relative_path, encoding, newline,
        mode='snippet',
        old_snippet=old_snippet or '',
        new_snippet=new_snippet if new_snippet is not None else '',
        land_in_workspace=land_in_workspace,
    )


STAGING_TOOLS: list[Any] = [
    stage_create_file,
    stage_workspace_file_overwrite,
    stage_line_range_edit,
    stage_snippet_edit,
]
