"""Python LSP diagnostics and status routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from nemo_backend.lsp.manager import get_session_lsp_manager
from nemo_backend.workspace_text_io import validate_workspace_encoding

router = APIRouter()


@router.get('/lsp/diagnostics')
async def lsp_diagnostics(
    session_id: str,
    relative_path: str = '',
    refresh_from_workspace: bool = False,
    encoding: str = 'utf-8',
) -> dict[str, object]:
    """Return normalized Python LSP diagnostics for one file or the whole session cache."""

    try:
        enc = validate_workspace_encoding(encoding)
        manager = get_session_lsp_manager(session_id, scope='workspace')
        rel = (relative_path or '').strip().replace('\\', '/')
        if rel:
            if refresh_from_workspace:
                manager.sync_workspace_document(rel, encoding=enc)
            diagnostics = manager.get_diagnostics(rel)
            return {'sessionId': session_id, 'relativePath': rel, 'diagnostics': diagnostics}
        diagnostics = manager.get_diagnostics()
        return {'sessionId': session_id, 'diagnostics': diagnostics}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/lsp/status')
async def lsp_status(session_id: str) -> dict[str, object]:
    """Return whether a Python LSP session is active for a workspace."""

    try:
        manager = get_session_lsp_manager(session_id, scope='workspace')
        return {
            'sessionId': session_id,
            'workspaceRoot': str(manager.workspace_root),
            'cachedDiagnostics': len(manager.get_diagnostics()),
            'language': 'python',
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
