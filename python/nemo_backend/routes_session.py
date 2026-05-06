"""Session lifecycle and workspace attachment routes."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from nemo_backend.checkpointing import delete_outer_threads_for_session
from nemo_backend.domain import SessionState
from nemo_backend.planner_graph_session import cleanup_planner_graph_session
from nemo_backend.workspace_index.embeddings_factory import build_embedding_model
from nemo_backend.workspace_index.incremental import enqueue_semantic_index_changes, flush_semantic_index_patches
from nemo_backend.workspace_index.lifecycle import (
    invalidate_staging_index_disk,
    invalidate_workspace_index_disk,
)
from nemo_backend.lsp.manager import shutdown_session_python_lsp
from nemo_backend.python_env import clear_session_python_workspace_env, ensure_session_python_workspace_env
from nemo_backend.python_interpreter_select import (
    apply_python_interpreter_entry,
    discover_workspace_python_interpreters,
    find_interpreter_entry_by_id,
)
from nemo_backend.schemas import (
    ClearRequest,
    LoadRequest,
    PythonInterpreterSelectRequest,
    SessionAutoApplyRequest,
    WorkspaceContextRequest,
)
from nemo_backend import state

router = APIRouter()
logger = logging.getLogger('nemo.http.routes')


@router.post('/clear')
async def clear_session(request: ClearRequest) -> dict[str, bool]:
    """Drop chat history for a session id (fresh SessionState)."""
    sid = request.session_id
    try:
        invalidate_staging_index_disk(sid)
    except Exception:
        logger.debug('invalidate staging semantic index on clear failed', exc_info=True)
    cleanup_planner_graph_session(state.get_session(sid), sid)
    await delete_outer_threads_for_session(sid)
    state.sessions[sid] = SessionState()
    return {'ok': True}


@router.post('/load')
async def load_session(request: LoadRequest) -> dict[str, bool]:
    """Bulk-restore messages into a session (typically after app restart)."""
    await delete_outer_threads_for_session(request.session_id)
    sess = state.get_session(request.session_id)
    restored: list[dict[str, Any]] = []
    for item in request.messages:
        role = item.get('role', 'user')
        content = item.get('content', '')
        if content is None:
            continue
        if isinstance(content, list):
            if len(content) == 0:
                continue
        elif isinstance(content, str):
            if not content.strip():
                continue
        else:
            continue
        restored.append({'role': str(role), 'content': content})
    sess.history = restored
    return {'ok': True}


@router.post('/workspace-context')
async def set_workspace_context(request: WorkspaceContextRequest) -> dict[str, bool]:
    """Attach or update workspace path and renderer-provided tree for a session."""
    sess = state.get_session(request.session_id)
    prev_path = (sess.workspace_path or '').strip()
    prev_wid = (sess.workspace_id or '').strip()
    new_path = (request.workspace_path or '').strip()
    workspace_path_changed = bool(prev_path and prev_path != new_path)
    if workspace_path_changed:
        cleanup_planner_graph_session(sess, request.session_id)
        if prev_path:
            try:
                invalidate_workspace_index_disk(prev_wid, Path(prev_path))
            except Exception:
                logger.debug('invalidate semantic index after workspace change failed', exc_info=True)
        sess.semantic_index_pending.clear()

    sess.workspace_path = request.workspace_path
    sess.workspace_context = request.workspace_context
    sess.workspace_id = (request.workspace_id or '').strip()

    ch = request.workspace_file_changes
    if ch and ch.paths:
        enqueue_semantic_index_changes(sess, ch.paths, ch.kinds)

    if new_path:
        try:
            conn = state.get_active_connection()
            embed_model, _em_err = build_embedding_model(conn)
            if embed_model is not None:
                flush_semantic_index_patches(
                    request.session_id,
                    sess,
                    Path(new_path),
                    sess.workspace_id,
                    embed_model,
                )
        except Exception:
            logger.debug('semantic index flush after workspace-context failed', exc_info=True)

    if not new_path:
        sess.semantic_index_pending.clear()
        clear_session_python_workspace_env(sess)
        return {'ok': True}

    interp = (request.python_interpreter_id or '').strip()
    if interp:
        entry = find_interpreter_entry_by_id(Path(new_path), interp)
        if entry is not None:
            apply_python_interpreter_entry(sess, Path(new_path), entry)
            shutdown_session_python_lsp(request.session_id)
        else:
            logger.warning(
                'unknown python_interpreter_id=%r for workspace session=%s',
                interp,
                request.session_id,
            )
    elif workspace_path_changed or not sess.python_workspace_python_executable:
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


@router.get('/session/python-interpreters')
async def list_python_interpreters(session_id: str = Query(...)) -> dict[str, Any]:
    """Discover Python interpreters under the session workspace (for editor picker)."""

    sess = state.get_session(session_id)
    wp = (sess.workspace_path or '').strip()
    if not wp:
        return {'interpreters': [], 'activeInterpreterId': None}
    rows = discover_workspace_python_interpreters(Path(wp))
    active = (sess.python_interpreter_choice_id or '').strip() or None
    return {'interpreters': rows, 'activeInterpreterId': active}


@router.post('/session/python-interpreter')
async def select_python_interpreter(request: PythonInterpreterSelectRequest) -> dict[str, Any]:
    """Apply interpreter selection and restart the Python LSP subprocess."""

    sess = state.get_session(request.session_id)
    wp = (sess.workspace_path or '').strip()
    if not wp:
        raise HTTPException(status_code=400, detail='No workspace attached.')
    root = Path(wp)
    entry = find_interpreter_entry_by_id(root, request.interpreter_id)
    if entry is None:
        raise HTTPException(status_code=400, detail='Unknown interpreter id.')
    apply_python_interpreter_entry(sess, root, entry)
    shutdown_session_python_lsp(request.session_id)
    return {'ok': True, 'interpreterId': entry['id']}


@router.post('/session/auto-apply')
async def session_auto_apply(request: SessionAutoApplyRequest) -> dict[str, bool]:
    """Update per-session auto-apply while a stream may be running (toolbar toggle)."""
    sess = state.get_session(request.session_id)
    sess.auto_apply_mode = request.auto_apply_mode
    return {'ok': True}
