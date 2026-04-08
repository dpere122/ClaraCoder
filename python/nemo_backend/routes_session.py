"""Session lifecycle and workspace attachment routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter

from nemo_backend.domain import SessionState
from nemo_backend.planner_graph_session import cleanup_planner_graph_session
from nemo_backend.python_env import clear_session_python_workspace_env, ensure_session_python_workspace_env
from nemo_backend.schemas import (
    ClearRequest,
    LoadRequest,
    SessionAutoApplyRequest,
    WorkspaceContextRequest,
)
from nemo_backend import state

router = APIRouter()
logger = logging.getLogger('nemo.http.routes')


@router.post('/clear')
async def clear_session(request: ClearRequest) -> dict[str, bool]:
    """Drop chat history for a session id (fresh SessionState)."""
    cleanup_planner_graph_session(state.get_session(request.session_id), request.session_id)
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
    """Attach or update workspace path and renderer-provided tree for a session."""
    sess = state.get_session(request.session_id)
    workspace_path_changed = bool(sess.workspace_path and sess.workspace_path != request.workspace_path)
    if workspace_path_changed:
        cleanup_planner_graph_session(sess, request.session_id)
    sess.workspace_path = request.workspace_path
    sess.workspace_context = request.workspace_context
    if not request.workspace_path.strip():
        clear_session_python_workspace_env(sess)
        return {'ok': True}
    if workspace_path_changed or not sess.python_workspace_python_executable:
        result = await ensure_session_python_workspace_env(
            sess,
            allow_workspace_root_fallback=False,
            bootstrap_dependencies=True,
        )
        if result is not None:
            logger.info(
                'workspace python env sync session=%s ok=%s root=%s',
                request.session_id,
                result.ok,
                result.project_root_label or '(none)',
            )
    return {'ok': True}


@router.post('/session/auto-apply')
async def session_auto_apply(request: SessionAutoApplyRequest) -> dict[str, bool]:
    """Update per-session auto-apply while a stream may be running (toolbar toggle)."""
    sess = state.get_session(request.session_id)
    sess.auto_apply_mode = request.auto_apply_mode
    return {'ok': True}
