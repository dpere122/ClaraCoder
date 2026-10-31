"""Session lifecycle and workspace attachment routes."""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from clara_coder_backend.domain import SessionState
from clara_coder_backend.workspace_index.incremental import enqueue_semantic_index_changes, schedule_semantic_index_background
from clara_coder_backend.workspace_index.embeddings_factory import embeddings_available
from clara_coder_backend.workspace_index.lifecycle import invalidate_workspace_index_disk
from clara_coder_backend.lsp.manager import (
    notify_session_lsp_disk_changes,
    shutdown_session_lsp,
    shutdown_session_python_lsp,
)
from clara_coder_backend.runtime.python_env import clear_session_python_workspace_env, ensure_session_python_workspace_env
from clara_coder_backend.runtime.python_interpreter_select import (
    apply_default_workspace_python_interpreter,
    apply_python_interpreter_entry,
    discover_workspace_python_interpreters,
    find_interpreter_entry_by_id,
)
from clara_coder_backend.session.chat_input import effective_user_message_content
from clara_coder_backend.session.checkpointing import delete_outer_threads_for_session
from clara_coder_backend.lang_agent.subagents import (
    is_subagent_session_id,
    live_subagent_runs,
    maybe_publish_results_ready,
    stop_subagent,
    stop_subagents,
    subagent_session,
)
from clara_coder_backend.session.lifecycle import clear_session_hitl_fields, teardown_session
from clara_coder_backend.session.turns import forget_session_turns, stop_session_turn
from clara_coder_backend.session.schemas import (
    ClearRequest,
    LoadRequest,
    PythonInterpreterSelectRequest,
    SessionAdminElevationRequest,
    SessionAutoApplyRequest,
    WorkspaceContextRequest,
    WorkspacePtyCwdRequest,
    WorkspacePtyExitRequest,
    WorkspacePtyOutputRequest,
    WorkspacePtyRegisterRequest,
    WorkspaceSystemPromptRequest,
)
from clara_coder_backend.workspace.npm_projects import discover_workspace_npm_projects
from clara_coder_backend.session import state
router = APIRouter()
logger = logging.getLogger('clara.http.routes')

_NPM_HINT_MAX_DEPTH = 4


def _forward_disk_changes_to_lsp(session_id: str, paths: list[str], kinds: list[str]) -> None:
    """Hand a watcher batch to the session's language servers without holding up the context sync.

    Runs on its own thread: a re-sync may wait on a per-document lock held by an agent edit that
    is waiting for diagnostics.
    """

    encoding = (state.runtime_config.tools.default_workspace_encoding or 'utf-8').strip() or 'utf-8'

    def _run() -> None:
        try:
            notify_session_lsp_disk_changes(session_id, paths, kinds, encoding=encoding)
        except Exception:
            logger.debug('LSP disk-change forward failed session=%s', session_id, exc_info=True)

    threading.Thread(target=_run, name='lsp-disk-changes', daemon=True).start()


def _apply_npm_project_hints(sess: SessionState, workspace_root: Path) -> None:
    """One bounded npm scan on workspace attach; may pre-fill TS LSP root when unambiguous."""

    hints = discover_workspace_npm_projects(workspace_root, max_depth=_NPM_HINT_MAX_DEPTH)
    sess.npm_project_hints = hints
    sess.npm_discovery_at = time.time()
    if len(hints) != 1 or (sess.typescript_lsp_resolved_root or '').strip():
        return
    rel = str(hints[0].get('relativeDir') or '.').strip().replace('\\', '/')
    if rel in ('', '.'):
        ts_root = workspace_root.resolve()
    else:
        ts_root = (workspace_root / rel).resolve()
    sess.typescript_lsp_resolved_root = str(ts_root)
    logger.info(
        'typescript project root pre-filled from single npm hint session workspace=%s root=%s',
        workspace_root,
        ts_root,
    )


async def _stop_session_activity(sid: str, *, discard_child_report: bool = False) -> None:
    """Stop the session's turn and its sub-agents before a reset, so none writes into a fresh thread.

    The conversation is going away (``/clear``, ``/dispose``): its sub-agents' reports are dropped.
    For a sub-agent id this stops just that sub-agent; its partial report goes to the main agent
    unless ``discard_child_report`` (``/dispose``: the sub-agent's conversation is deleted, e.g. a
    restore removed the turn that spawned it, so its work must not come back as a report).
    """
    child = subagent_session(sid)
    if child is not None:
        await stop_subagent(sid, discard_report=discard_child_report)
        return
    await stop_session_turn(sid)
    await stop_subagents(state.sessions.get(sid), discard_reports=True)


@router.post('/clear')
async def clear_session(request: ClearRequest) -> dict[str, bool]:
    """Reset a session to a fresh SessionState and drop outer LangGraph checkpoints.

    After clear, Electron SQLite (empty or new chat) is the source of truth for the next
    model turn — checkpoint delta history must not outlive this resync. A running turn
    (and its sub-agents) is stopped first.
    """
    sid = request.session_id
    await _stop_session_activity(sid)
    await teardown_session(sid)
    if not is_subagent_session_id(sid):
        state.sessions[sid] = SessionState()
    return {'ok': True}


@router.post('/dispose')
async def dispose_session(request: ClearRequest) -> dict[str, bool]:
    """Teardown a session and remove it from the in-memory store (conversation deleted)."""
    sid = request.session_id
    await _stop_session_activity(sid, discard_child_report=True)
    await teardown_session(sid)
    state.sessions.pop(sid, None)
    forget_session_turns(sid)
    return {'ok': True}


def _load_message_content(item: dict[str, Any], role: str) -> str | list[dict[str, Any]] | None:
    """Normalize one /load row into history content, or None to skip."""
    if role == 'user':
        structured = item.get('structured_content')
        if structured is None:
            structured = item.get('structuredContent')
        message = item.get('message')
        if message is not None or structured is not None:
            content: str | list[dict[str, Any]] | None = effective_user_message_content(
                str(message or ''),
                structured if isinstance(structured, list) else None,
            )
        else:
            # Legacy shape: already-normalized ``content`` (string or multimodal list).
            content = item.get('content', '')
    else:
        content = item.get('content', '')

    if content is None:
        return None
    if isinstance(content, list):
        return content if len(content) > 0 else None
    if isinstance(content, str):
        return content if content.strip() else None
    return None


@router.post('/load')
async def load_session(request: LoadRequest) -> dict[str, Any]:
    """Bulk-restore messages into a session (typically after app restart or conversation switch).

    Replaces slim history from Electron SQLite and clears outer LangGraph checkpoints so the
    next model turn rebuilds from loaded history (SQLite is authoritative after resync). With
    ``keep_matching_checkpoint``, a checkpoint that covers exactly this history stays, and the
    next turn continues from it (tool calls and results included); the response then carries
    ``kept_checkpoint`` and the context meter's last reading, ``context_tokens``.
    Live HITL/pause fields are abandoned; workspace/LSP attachment is preserved. A running
    turn is stopped first; the conversation's sub-agents keep running and their waiting reports
    stay (``subagent_results_ready`` goes out if some wait). Sub-agent conversations are never loaded.
    """
    if is_subagent_session_id(request.session_id):
        return {'ok': True}
    await stop_session_turn(request.session_id)
    sess = state.get_session(request.session_id)
    restored: list[dict[str, Any]] = []
    for item in request.messages:
        role = str(item.get('role', 'user'))
        content = _load_message_content(item, role)
        if content is None:
            continue
        restored.append({'role': role, 'content': content})
    kept_context = await delete_outer_threads_for_session(
        request.session_id,
        keep_matching=restored if request.keep_matching_checkpoint else None,
    )
    clear_session_hitl_fields(sess)
    if kept_context is None:
        # Results for spawn calls of a checkpoint that is gone now.
        sess.subagent_interrupted_reports.clear()
    sess.history = restored
    if live_subagent_runs(sess) or sess.subagent_pending_reports:
        logger.info(
            'load kept %d running sub-agent(s) and %d waiting report(s) session=%s',
            len(live_subagent_runs(sess)),
            len(sess.subagent_pending_reports),
            request.session_id,
        )
    maybe_publish_results_ready(request.session_id)
    if kept_context is None:
        return {'ok': True}
    # The meter's last reading for the kept checkpoint (0 when the model reported no usage).
    return {'ok': True, 'kept_checkpoint': True, 'context_tokens': kept_context}


@router.post('/workspace-system-prompt')
async def set_workspace_system_prompt(request: WorkspaceSystemPromptRequest) -> dict[str, bool]:
    """Set or clear the managed workspace system-prompt text for a session (no tree rebuild)."""
    sess = state.get_session(request.session_id)
    sess.workspace_system_prompt = (request.workspace_system_prompt or '').strip()
    return {'ok': True}


@router.post('/workspace-context')
async def set_workspace_context(request: WorkspaceContextRequest) -> dict[str, bool]:
    """Attach or update workspace path and renderer-provided tree for a session."""
    sess = state.get_session(request.session_id)
    prev_path = (sess.workspace_path or '').strip()
    prev_wid = (sess.workspace_id or '').strip()
    new_path = (request.workspace_path or '').strip()
    workspace_first_attach = bool(new_path and not prev_path)
    workspace_path_changed = bool(prev_path and prev_path != new_path)
    if workspace_path_changed:
        shutdown_session_lsp(request.session_id)
        if prev_path:
            try:
                invalidate_workspace_index_disk(prev_wid, Path(prev_path))
            except Exception:
                logger.debug('invalidate semantic index after workspace change failed', exc_info=True)
        sess.semantic_index_pending.clear()
        sess.npm_project_hints = None
        sess.npm_discovery_at = None
        sess.typescript_lsp_resolved_root = ''
        sess.java_lsp_resolved_root = ''

    sess.workspace_path = request.workspace_path
    sess.workspace_context = request.workspace_context
    sess.workspace_id = (request.workspace_id or '').strip()
    sess.workspace_system_prompt = (request.workspace_system_prompt or '').strip()

    ch = request.workspace_file_changes
    if ch and ch.paths:
        enqueue_semantic_index_changes(sess, ch.paths, ch.kinds)
        if not workspace_path_changed:
            _forward_disk_changes_to_lsp(request.session_id, list(ch.paths), list(ch.kinds))

    if new_path:
        ensure_corpus = workspace_first_attach or workspace_path_changed
        conn = state.get_active_connection()
        embeddings_ok, _ = embeddings_available(conn)
        if embeddings_ok and (ensure_corpus or sess.semantic_index_pending):
            schedule_semantic_index_background(
                request.session_id,
                ensure_corpus=ensure_corpus,
            )

    if not new_path:
        sess.semantic_index_pending.clear()
        clear_session_python_workspace_env(sess)
        sess.npm_project_hints = None
        sess.npm_discovery_at = None
        return {'ok': True}

    if workspace_path_changed or workspace_first_attach:
        _apply_npm_project_hints(sess, Path(new_path))

    skip_env = bool(request.skip_env_bootstrap)
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
    elif not skip_env and request.bootstrap_python_env:
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
    elif not skip_env and not (sess.python_workspace_python_executable or '').strip():
        # Default: Clara runtime venv (or app-backend) — user override via python_interpreter_id.
        entry = apply_default_workspace_python_interpreter(sess, Path(new_path))
        if entry is not None:
            shutdown_session_python_lsp(request.session_id)
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
    """Update per-session auto-apply while a stream may be running (toolbar toggle).

    Running sub-agents follow their parent's toggle.
    """
    if is_subagent_session_id(request.session_id):
        return {'ok': True}
    sess = state.get_session(request.session_id)
    sess.auto_apply_mode = request.auto_apply_mode
    for child_id in list(sess.subagent_children):
        child = subagent_session(child_id)
        if child is not None:
            child.auto_apply_mode = request.auto_apply_mode
    return {'ok': True}


@router.post('/session/admin-elevation')
async def session_admin_elevation(request: SessionAdminElevationRequest) -> dict[str, bool | str]:
    """Grant or revoke per-session admin ``run_command`` (composer Admin chip).

    Grant starts the elevated helper immediately so UAC/polkit appears here,
    not on the next ``run_command``.
    """
    from clara_coder_backend.runtime.admin_exec import shutdown_session_broker, warmup_persistent_broker

    sess = state.get_session(request.session_id)
    if not request.granted:
        sess.admin_elevation_granted = False
        await shutdown_session_broker(request.session_id)
        return {'ok': True, 'granted': False}

    err = await warmup_persistent_broker(request.session_id)
    if err:
        sess.admin_elevation_granted = False
        return {'ok': False, 'granted': False, 'error': err}
    sess.admin_elevation_granted = True
    return {'ok': True, 'granted': True}


@router.post('/workspace-pty/register')
async def workspace_pty_register(request: WorkspacePtyRegisterRequest) -> dict[str, bool]:
    """Register or update an active user PTY terminal session mirrored from Electron."""
    from clara_coder_backend.tools.user_terminals import register_user_pty_terminal

    register_user_pty_terminal(
        session_id=request.session_id,
        workspace_root=request.workspace_root,
        cwd=request.cwd,
        shell=request.shell,
        pid=request.pid,
        cols=request.cols,
        rows=request.rows,
    )
    return {'ok': True}


@router.post('/workspace-pty/output')
async def workspace_pty_output(request: WorkspacePtyOutputRequest) -> dict[str, bool]:
    """Append output chunk (and optional OSC 7 cwd) for a user PTY terminal."""
    from clara_coder_backend.tools.user_terminals import append_user_pty_output

    ok = append_user_pty_output(request.session_id, request.data, cwd=request.cwd)
    return {'ok': ok}


@router.post('/workspace-pty/cwd')
async def workspace_pty_cwd(request: WorkspacePtyCwdRequest) -> dict[str, bool]:
    """Update the last known filesystem cwd for a user PTY terminal."""
    from clara_coder_backend.tools.user_terminals import update_user_pty_cwd

    ok = update_user_pty_cwd(request.session_id, request.cwd)
    return {'ok': ok}


@router.post('/workspace-pty/exit')
async def workspace_pty_exit(request: WorkspacePtyExitRequest) -> dict[str, bool]:
    """Mark a user PTY terminal as exited or remove it when the tab is closed."""
    from clara_coder_backend.tools.user_terminals import mark_user_pty_exited, remove_user_pty_terminal

    if request.removed:
        ok = remove_user_pty_terminal(request.session_id)
    else:
        ok = mark_user_pty_exited(request.session_id, request.exit_code)
    return {'ok': ok}


@router.post('/workspace-pty/clear-all')
async def workspace_pty_clear_all() -> dict[str, bool]:
    """Clear all mirrored user PTY terminals (workspace switch or app shutdown)."""
    from clara_coder_backend.tools.user_terminals import clear_all_user_pty_terminals

    clear_all_user_pty_terminals()
    return {'ok': True}

