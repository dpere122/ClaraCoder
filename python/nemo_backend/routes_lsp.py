"""LSP diagnostics and status routes."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from nemo_backend.lsp.editor_monaco import (
    serialize_code_actions_payload,
    serialize_code_lenses_payload,
    serialize_completion_result,
    serialize_diagnostics_payload,
    serialize_document_highlights_payload,
    serialize_document_symbols_payload,
    serialize_inlay_hints_payload,
    serialize_locations_payload,
    serialize_rename_workspace_edit,
    serialize_semantic_tokens_delta_payload,
    serialize_semantic_tokens_payload,
    serialize_signature_help_payload,
    serialize_text_edits_list,
    _lsp_range_to_monaco_irange,
)
from nemo_backend.lsp.file_policy import lsp_server_for_path, normalize_relative_posix_path
from nemo_backend.lsp.manager import get_lsp_dashboard_status, get_session_lsp_manager, list_session_diagnostics
from nemo_backend.lsp.registry import lsp_server_id_is_registered
from nemo_backend.python_env import ensure_session_python_workspace_env
from nemo_backend.state import get_session
from nemo_backend.tools.lsp_tools import _format_hover_contents
from nemo_backend.workspace_text_io import validate_workspace_encoding

router = APIRouter()


async def _bootstrap_python_env_if_needed(session_id: str, *, server: str | None = None) -> None:
    """Ensure workspace Python env is resolved before starting Jedi (deferred from workspace attach)."""

    if server is not None and server != 'python':
        return
    sess = get_session(session_id)
    if (sess.python_workspace_python_executable or '').strip():
        return
    if not (sess.workspace_path or '').strip():
        return
    await ensure_session_python_workspace_env(
        sess,
        allow_workspace_root_fallback=False,
        bootstrap_dependencies=True,
    )


async def _bootstrap_python_env_for_relative_path(session_id: str, relative_path: str) -> None:
    server = lsp_server_for_path(relative_path)
    await _bootstrap_python_env_if_needed(session_id, server=server)


def _lsp_diagnostics_sync(
    session_id: str,
    enc: str,
    rel: str,
    refresh_disk: bool,
) -> dict[str, object]:
    if rel:
        server = lsp_server_for_path(rel)
        if not server:
            raise ValueError(f'No LSP integration for `{rel}`.')
        manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
        if refresh_disk:
            manager.sync_workspace_document(rel, encoding=enc)
        diagnostics = manager.get_diagnostics(rel)
        return {'sessionId': session_id, 'relativePath': rel, 'diagnostics': diagnostics, 'server': server}
    diagnostics = list_session_diagnostics(session_id, scope='workspace')
    return {'sessionId': session_id, 'diagnostics': diagnostics}


def _lsp_semantic_tokens_legend_sync(session_id: str, srv: str) -> dict[str, Any]:
    manager = get_session_lsp_manager(session_id, scope='workspace', server=srv)
    if manager.should_defer_semantic_tokens_legend_without_document_seed():
        return {'tokenTypes': [], 'tokenModifiers': [], 'supported': False}
    manager.ensure_started()
    leg = manager.semantic_tokens_legend
    if leg is None:
        return {'tokenTypes': [], 'tokenModifiers': [], 'supported': False}
    return {
        'tokenTypes': list(leg.get('tokenTypes') or []),
        'tokenModifiers': list(leg.get('tokenModifiers') or []),
        'supported': True,
    }


def _lsp_editor_hover_sync(
    session_id: str,
    relative_path: str,
    line: int,
    character: int,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    if not skip_document_sync and document_text is not None:
        manager.sync_document(rel, document_text, wait_for_diagnostics=False)
    result = manager.hover(rel, line, character)
    raw_contents = result.get('contents') if isinstance(result, dict) else None
    if raw_contents is None:
        return {'markdown': None, 'range': None}
    text = _format_hover_contents(raw_contents).strip()
    hover_range = None
    if isinstance(result, dict):
        hover_range = _lsp_range_to_monaco_irange(result.get('range'))
    return {'markdown': text or None, 'range': hover_range}


def _maybe_sync_buffer(
    manager: Any,
    rel: str,
    document_text: str | None,
    *,
    wait_for_diagnostics: bool = False,
    skip_document_sync: bool = False,
) -> None:
    if skip_document_sync:
        return
    if document_text is not None:
        manager.sync_document(rel, document_text, wait_for_diagnostics=wait_for_diagnostics)


def _lsp_editor_definition_sync(
    session_id: str,
    relative_path: str,
    line: int,
    character: int,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.definition(rel, line, character)
    locations = serialize_locations_payload(manager, raw)
    return {'locations': locations}


def _lsp_editor_references_sync(
    session_id: str,
    relative_path: str,
    line: int,
    character: int,
    document_text: str | None,
    include_declaration: bool,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.references(rel, line, character, include_declaration=include_declaration)
    locations = serialize_locations_payload(manager, raw)
    return {'locations': locations}


def _lsp_editor_document_symbols_sync(
    session_id: str,
    relative_path: str,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.document_symbols(rel)
    return serialize_document_symbols_payload(manager, raw)


def _lsp_editor_completion_sync(
    session_id: str,
    relative_path: str,
    line: int,
    character: int,
    document_text: str | None,
    trigger_kind: int,
    trigger_character: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    tc = trigger_character
    raw = manager.completion(
        rel,
        line,
        character,
        trigger_kind=int(trigger_kind),
        trigger_character=tc if tc not in (None, '') else None,
    )
    return serialize_completion_result(manager, raw)


def _lsp_editor_rename_sync(
    session_id: str,
    relative_path: str,
    line: int,
    character: int,
    document_text: str | None,
    new_name: str,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.rename(rel, line, character, new_name)
    if raw is None:
        return {'workspaceEdit': None}
    payload = serialize_rename_workspace_edit(manager, raw)
    return {'workspaceEdit': payload}


def _lsp_semantic_tokens_full_sync(
    session_id: str,
    relative_path: str,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.semantic_tokens_full(rel)
    return serialize_semantic_tokens_payload(manager, raw)


def _lsp_editor_diagnostics_sync(
    session_id: str,
    relative_path: str,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    if not skip_document_sync and document_text is not None:
        manager.sync_document(rel, document_text, wait_for_diagnostics=True)
    diagnostics = manager.get_diagnostics(rel)
    generation = manager.get_diag_generation(rel)
    return {
        'diagnostics': serialize_diagnostics_payload(diagnostics),
        'generation': generation,
    }


def _lsp_editor_signature_help_sync(
    session_id: str,
    relative_path: str,
    line: int,
    character: int,
    document_text: str | None,
    trigger_character: str | None,
    is_retrigger: bool,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.signature_help(
        rel,
        line,
        character,
        trigger_character=trigger_character if trigger_character else None,
        is_retrigger=is_retrigger,
    )
    return {'signatureHelp': serialize_signature_help_payload(raw)}


def _lsp_editor_document_highlight_sync(
    session_id: str,
    relative_path: str,
    line: int,
    character: int,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.document_highlight(rel, line, character)
    return {'highlights': serialize_document_highlights_payload(raw)}


def _lsp_editor_completion_resolve_sync(
    session_id: str,
    relative_path: str,
    item: dict[str, Any],
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    manager.ensure_started()
    raw = manager.completion_resolve(item)
    return serialize_completion_result(manager, {'items': [raw] if isinstance(raw, dict) else raw})


def _lsp_editor_code_action_sync(
    session_id: str,
    relative_path: str,
    start_line: int,
    start_character: int,
    end_line: int,
    end_character: int,
    document_text: str | None,
    diagnostics: list[dict[str, Any]],
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.code_action(rel, start_line, start_character, end_line, end_character, diagnostics)
    return {'actions': serialize_code_actions_payload(manager, raw)}


def _lsp_editor_formatting_sync(
    session_id: str,
    relative_path: str,
    document_text: str | None,
    tab_size: int,
    insert_spaces: bool,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.formatting(rel, tab_size=tab_size, insert_spaces=insert_spaces)
    return {'edits': serialize_text_edits_list(raw)}


def _lsp_editor_range_formatting_sync(
    session_id: str,
    relative_path: str,
    start_line: int,
    start_character: int,
    end_line: int,
    end_character: int,
    document_text: str | None,
    tab_size: int,
    insert_spaces: bool,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.range_formatting(
        rel,
        start_line,
        start_character,
        end_line,
        end_character,
        tab_size=tab_size,
        insert_spaces=insert_spaces,
    )
    return {'edits': serialize_text_edits_list(raw)}


def _lsp_editor_on_type_formatting_sync(
    session_id: str,
    relative_path: str,
    line: int,
    character: int,
    ch: str,
    document_text: str | None,
    tab_size: int,
    insert_spaces: bool,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.on_type_formatting(rel, line, character, ch, tab_size=tab_size, insert_spaces=insert_spaces)
    return {'edits': serialize_text_edits_list(raw)}


def _lsp_editor_inlay_hints_sync(
    session_id: str,
    relative_path: str,
    start_line: int,
    start_character: int,
    end_line: int,
    end_character: int,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.inlay_hints(rel, start_line, start_character, end_line, end_character)
    return {'hints': serialize_inlay_hints_payload(raw)}


def _lsp_editor_code_lens_sync(
    session_id: str,
    relative_path: str,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.code_lens(rel)
    return {'lenses': serialize_code_lenses_payload(raw)}


def _lsp_editor_code_lens_resolve_sync(
    session_id: str,
    relative_path: str,
    lens: dict[str, Any],
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    manager.ensure_started()
    raw = manager.code_lens_resolve(lens)
    if not isinstance(raw, dict):
        return {'lens': None}
    resolved = serialize_code_lenses_payload([raw])
    return {'lens': resolved[0] if resolved else None}


def _lsp_editor_semantic_tokens_delta_sync(
    session_id: str,
    relative_path: str,
    previous_result_id: str,
    document_text: str | None,
    *,
    skip_document_sync: bool = False,
) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    _maybe_sync_buffer(manager, rel, document_text, skip_document_sync=skip_document_sync)
    raw = manager.semantic_tokens_full_delta(rel, previous_result_id)
    return serialize_semantic_tokens_delta_payload(manager, raw)


def _lsp_diagnostics_generation_sync(session_id: str, relative_path: str) -> dict[str, Any]:
    rel = normalize_relative_posix_path(relative_path.strip())
    server = lsp_server_for_path(rel)
    if not server:
        raise ValueError(f'No LSP integration for `{rel}`.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
    return {
        'relativePath': rel,
        'generation': manager.get_diag_generation(rel),
        'count': len(manager.get_diagnostics(rel)),
    }


class LspEditorHoverBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    line: int = Field(..., ge=1)
    character: int = Field(..., ge=1)
    document_text: str | None = None
    skip_document_sync: bool = False


class LspEditorPositionBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    line: int = Field(..., ge=1)
    character: int = Field(..., ge=1)
    document_text: str | None = None
    skip_document_sync: bool = False


class LspEditorReferencesBody(LspEditorPositionBody):
    include_declaration: bool = False


class LspEditorDocumentSymbolsBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    document_text: str | None = None
    skip_document_sync: bool = False


class LspEditorCompletionBody(LspEditorPositionBody):
    trigger_kind: int = Field(default=1, ge=1, le=3)
    trigger_character: str | None = None


class LspEditorRenameBody(LspEditorPositionBody):
    new_name: str = Field(..., min_length=1)


class LspSemanticTokensFullBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    document_text: str | None = None
    skip_document_sync: bool = False


class LspEditorDiagnosticsBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    document_text: str | None = None
    skip_document_sync: bool = False


class LspEditorSignatureHelpBody(LspEditorPositionBody):
    trigger_character: str | None = None
    is_retrigger: bool = False


class LspEditorRangeBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    start_line: int = Field(..., ge=1)
    start_character: int = Field(..., ge=1)
    end_line: int = Field(..., ge=1)
    end_character: int = Field(..., ge=1)
    document_text: str | None = None
    skip_document_sync: bool = False


class LspEditorCodeActionBody(LspEditorRangeBody):
    diagnostics: list[dict[str, Any]] = Field(default_factory=list)


class LspEditorFormattingBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    document_text: str | None = None
    skip_document_sync: bool = False
    tab_size: int = Field(default=4, ge=1, le=16)
    insert_spaces: bool = True


class LspEditorRangeFormattingBody(LspEditorRangeBody):
    tab_size: int = Field(default=4, ge=1, le=16)
    insert_spaces: bool = True


class LspEditorOnTypeFormattingBody(LspEditorPositionBody):
    ch: str = Field(..., min_length=1, max_length=1)
    tab_size: int = Field(default=4, ge=1, le=16)
    insert_spaces: bool = True


class LspEditorCompletionResolveBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    item: dict[str, Any] = Field(default_factory=dict)


class LspEditorCodeLensResolveBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    lens: dict[str, Any] = Field(default_factory=dict)


class LspSemanticTokensDeltaBody(BaseModel):
    relative_path: str = Field(..., min_length=1)
    previous_result_id: str = Field(..., min_length=1)
    document_text: str | None = None
    skip_document_sync: bool = False


@router.get('/lsp/diagnostics')
async def lsp_diagnostics(
    session_id: str,
    relative_path: str = '',
    refresh_active_document: bool = False,
    refresh_from_workspace: bool = False,
    encoding: str = 'utf-8',
) -> dict[str, object]:
    """Return normalized LSP diagnostics for one file or the whole session cache (Python + TS/JS).

    This route always uses workspace LSP scope. ``refresh_active_document`` re-reads the on-disk file before returning.
    ``refresh_from_workspace`` is a deprecated alias for ``refresh_active_document`` (same behavior).
    """

    try:
        enc = validate_workspace_encoding(encoding)
        rel = (relative_path or '').strip().replace('\\', '/')
        refresh_disk = refresh_active_document or refresh_from_workspace
        if rel:
            server = lsp_server_for_path(rel)
            if server:
                await _bootstrap_python_env_if_needed(session_id, server=server)
        return await asyncio.to_thread(_lsp_diagnostics_sync, session_id, enc, rel, refresh_disk)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/lsp/semantic-tokens-legend')
async def lsp_semantic_tokens_legend(session_id: str, server: str) -> dict[str, Any]:
    """Return semantic token legend, starting the server only when the plugin allows cold legend."""

    try:
        srv = (server or '').strip().lower()
        if not lsp_server_id_is_registered(srv):
            raise ValueError(f'Unknown LSP server id: {srv!r}.')
        await _bootstrap_python_env_if_needed(session_id, server=srv)
        return await asyncio.to_thread(_lsp_semantic_tokens_legend_sync, session_id, srv)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/lsp/status')
async def lsp_status(session_id: str) -> dict[str, object]:
    """Return workspace root and whether each LSP subprocess has been started (Python / TypeScript)."""

    try:
        return get_lsp_dashboard_status(session_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _lsp_warm_server_sync(session_id: str, server: str) -> dict[str, str]:
    srv = (server or '').strip().lower()
    if not lsp_server_id_is_registered(srv):
        raise ValueError(f'Unknown LSP server id: {srv!r}.')
    manager = get_session_lsp_manager(session_id, scope='workspace', server=srv)
    manager.ensure_started()
    return {'sessionId': session_id, 'server': srv}


@router.post('/lsp/warm-server')
async def lsp_warm_server(session_id: str, server: str) -> dict[str, str]:
    """Start the given language-server subprocess if needed (no document sync)."""

    try:
        await _bootstrap_python_env_if_needed(session_id, server=server)
        return await asyncio.to_thread(_lsp_warm_server_sync, session_id, server)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/hover')
async def lsp_editor_hover(
    session_id: str,
    body: LspEditorHoverBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """Workspace-editor hover: sync buffer (optional), then ``textDocument/hover``.

    Positions are **1-based** line and column (Monaco-compatible). When ``document_text``
    is sent, the LSP sees the in-memory buffer; otherwise the file is synced from disk.
    """

    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_hover_sync,
            session_id,
            body.relative_path,
            body.line,
            body.character,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/definition')
async def lsp_editor_definition(
    session_id: str,
    body: LspEditorPositionBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """Workspace go-to-definition (``textDocument/definition``); positions are 1-based."""

    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_definition_sync,
            session_id,
            body.relative_path,
            body.line,
            body.character,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/references')
async def lsp_editor_references(
    session_id: str,
    body: LspEditorReferencesBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """Workspace find references (``textDocument/references``); positions are 1-based."""

    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_references_sync,
            session_id,
            body.relative_path,
            body.line,
            body.character,
            body.document_text,
            body.include_declaration,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/document-symbols')
async def lsp_editor_document_symbols(
    session_id: str,
    body: LspEditorDocumentSymbolsBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """Document outline symbols (``textDocument/documentSymbol``)."""

    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_document_symbols_sync,
            session_id,
            body.relative_path,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/completion')
async def lsp_editor_completion(
    session_id: str,
    body: LspEditorCompletionBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """IntelliSense (``textDocument/completion``)."""

    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_completion_sync,
            session_id,
            body.relative_path,
            body.line,
            body.character,
            body.document_text,
            body.trigger_kind,
            body.trigger_character,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/rename')
async def lsp_editor_rename(
    session_id: str,
    body: LspEditorRenameBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """Rename symbol (``textDocument/rename``) → workspace-relative edit groups."""

    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_rename_sync,
            session_id,
            body.relative_path,
            body.line,
            body.character,
            body.document_text,
            body.new_name,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/semantic-tokens/full')
async def lsp_semantic_tokens_full(
    session_id: str,
    body: LspSemanticTokensFullBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """Workspace semantic highlighting (``textDocument/semanticTokens/full``)."""

    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_semantic_tokens_full_sync,
            session_id,
            body.relative_path,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/editor/diagnostics')
async def lsp_editor_diagnostics(
    session_id: str,
    body: LspEditorDiagnosticsBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """Sync in-memory buffer and return cached LSP diagnostics for Monaco markers."""

    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_diagnostics_sync,
            session_id,
            body.relative_path,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/lsp/diagnostics-generation')
async def lsp_diagnostics_generation(
    session_id: str,
    relative_path: str,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    """Lightweight poll endpoint for live diagnostics push (generation counter)."""

    try:
        validate_workspace_encoding(encoding)
        rel = (relative_path or '').strip().replace('\\', '/')
        if not rel:
            raise ValueError('relative_path is required.')
        await _bootstrap_python_env_for_relative_path(session_id, rel)
        return await asyncio.to_thread(_lsp_diagnostics_generation_sync, session_id, rel)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/signature-help')
async def lsp_editor_signature_help(
    session_id: str,
    body: LspEditorSignatureHelpBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_signature_help_sync,
            session_id,
            body.relative_path,
            body.line,
            body.character,
            body.document_text,
            body.trigger_character,
            body.is_retrigger,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/document-highlight')
async def lsp_editor_document_highlight(
    session_id: str,
    body: LspEditorPositionBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_document_highlight_sync,
            session_id,
            body.relative_path,
            body.line,
            body.character,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/completion-resolve')
async def lsp_editor_completion_resolve(
    session_id: str,
    body: LspEditorCompletionResolveBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_completion_resolve_sync,
            session_id,
            body.relative_path,
            body.item,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/code-action')
async def lsp_editor_code_action(
    session_id: str,
    body: LspEditorCodeActionBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_code_action_sync,
            session_id,
            body.relative_path,
            body.start_line,
            body.start_character,
            body.end_line,
            body.end_character,
            body.document_text,
            body.diagnostics,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/formatting')
async def lsp_editor_formatting(
    session_id: str,
    body: LspEditorFormattingBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_formatting_sync,
            session_id,
            body.relative_path,
            body.document_text,
            body.tab_size,
            body.insert_spaces,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/range-formatting')
async def lsp_editor_range_formatting(
    session_id: str,
    body: LspEditorRangeFormattingBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_range_formatting_sync,
            session_id,
            body.relative_path,
            body.start_line,
            body.start_character,
            body.end_line,
            body.end_character,
            body.document_text,
            body.tab_size,
            body.insert_spaces,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/on-type-formatting')
async def lsp_editor_on_type_formatting(
    session_id: str,
    body: LspEditorOnTypeFormattingBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_on_type_formatting_sync,
            session_id,
            body.relative_path,
            body.line,
            body.character,
            body.ch,
            body.document_text,
            body.tab_size,
            body.insert_spaces,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/inlay-hints')
async def lsp_editor_inlay_hints(
    session_id: str,
    body: LspEditorRangeBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_inlay_hints_sync,
            session_id,
            body.relative_path,
            body.start_line,
            body.start_character,
            body.end_line,
            body.end_character,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/code-lens')
async def lsp_editor_code_lens(
    session_id: str,
    body: LspEditorDocumentSymbolsBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_code_lens_sync,
            session_id,
            body.relative_path,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/code-lens/resolve')
async def lsp_editor_code_lens_resolve(
    session_id: str,
    body: LspEditorCodeLensResolveBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_code_lens_resolve_sync,
            session_id,
            body.relative_path,
            body.lens,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/lsp/semantic-tokens/full/delta')
async def lsp_semantic_tokens_full_delta(
    session_id: str,
    body: LspSemanticTokensDeltaBody,
    encoding: str = 'utf-8',
) -> dict[str, Any]:
    try:
        validate_workspace_encoding(encoding)
        await _bootstrap_python_env_for_relative_path(session_id, body.relative_path)
        return await asyncio.to_thread(
            _lsp_editor_semantic_tokens_delta_sync,
            session_id,
            body.relative_path,
            body.previous_result_id,
            body.document_text,
            skip_document_sync=body.skip_document_sync,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
