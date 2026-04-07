"""Session lifecycle and workspace attachment routes."""

from __future__ import annotations

from fastapi import APIRouter

from nemo_backend.domain import SessionState
from nemo_backend.schemas import (
    ClearRequest,
    LoadRequest,
    SessionAutoApplyRequest,
    WorkspaceContextRequest,
)
from nemo_backend import state

router = APIRouter()


@router.post('/clear')
async def clear_session(request: ClearRequest) -> dict[str, bool]:
    """Drop chat history for a session id (fresh SessionState)."""
    state.sessions[request.session_id] = SessionState()
    return {'ok': True}


@router.post('/load')
async def load_session(request: LoadRequest) -> dict[str, bool]:
    """Bulk-restore messages into a session (typically after app restart)."""
    sess = state.get_session(request.session_id)
    sess.history = [
        {
            'role': item.get('role', 'user'),
            'content': item.get('content', ''),
        }
        for item in request.messages
        if item.get('content')
    ]
    return {'ok': True}


@router.post('/workspace-context')
async def set_workspace_context(request: WorkspaceContextRequest) -> dict[str, bool]:
    """Attach or update workspace path and renderer-provided tree/state for a session."""
    sess = state.get_session(request.session_id)
    sess.workspace_path = request.workspace_path
    sess.workspace_context = request.workspace_context
    sess.workspace_state = request.workspace_state
    return {'ok': True}


@router.post('/session/auto-apply')
async def session_auto_apply(request: SessionAutoApplyRequest) -> dict[str, bool]:
    """Update per-session auto-apply while a stream may be running (toolbar toggle)."""
    sess = state.get_session(request.session_id)
    sess.auto_apply_mode = request.auto_apply_mode
    return {'ok': True}
