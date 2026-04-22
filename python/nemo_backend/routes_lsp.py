"""LSP diagnostics and status routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from nemo_backend.lsp.file_policy import lsp_server_for_path
from nemo_backend.lsp.manager import get_lsp_dashboard_status, get_session_lsp_manager, list_session_diagnostics
from nemo_backend.workspace_text_io import validate_workspace_encoding

router = APIRouter()


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
            if not server:
                raise ValueError(f'No LSP integration for `{rel}`.')
            manager = get_session_lsp_manager(session_id, scope='workspace', server=server)
            if refresh_disk:
                manager.sync_workspace_document(rel, encoding=enc)
            diagnostics = manager.get_diagnostics(rel)
            return {'sessionId': session_id, 'relativePath': rel, 'diagnostics': diagnostics, 'server': server}
        diagnostics = list_session_diagnostics(session_id, scope='workspace')
        return {'sessionId': session_id, 'diagnostics': diagnostics}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/lsp/status')
async def lsp_status(session_id: str) -> dict[str, object]:
    """Return workspace root and whether each LSP subprocess has been started (Python / TypeScript)."""

    try:
        return get_lsp_dashboard_status(session_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
