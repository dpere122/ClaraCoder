"""Helpers to bootstrap a fresh planner graph against a clean staging namespace."""

from __future__ import annotations

from pathlib import Path

from nemo_backend import edit_staging
from nemo_backend.agents.specialists.review_tools import rollback_test_run_materializations
from nemo_backend.domain import SessionState
from nemo_backend.lsp.manager import shutdown_session_lsp


def prepare_new_planner_graph_session(session: SessionState, session_id: str) -> str:
    """Reset planner-local runtime state, then seed a fresh staging snapshot from the workspace."""
    shutdown_session_lsp(session_id)
    if session.test_run_materializations:
        rollback_test_run_materializations(session)
    session.pending_diff_payload = None
    session.pending_delete_request = None
    session.pending_copy_request = None
    session.pending_accept_command_request = None
    session.pending_project_review_reentry = None
    session.lsp_diagnostics.clear()
    session.lsp_workspace_root = ''
    session.lsp_active_scope = 'workspace'

    workspace_root = Path(session.workspace_path).resolve()
    if not workspace_root.is_dir():
        raise ValueError('This conversation does not have a workspace attached.')
    return edit_staging.begin_planner_graph_staging_session(session, session_id, workspace_root)


def cleanup_planner_graph_session(session: SessionState, session_id: str) -> None:
    """Best-effort cleanup for planner graph staging state after the outer turn completes."""
    shutdown_session_lsp(session_id)
    if session.test_run_materializations:
        rollback_test_run_materializations(session)
    edit_staging.discard_all_session_stagings(session)
    edit_staging.clear_session_staging_dir(session_id)
    session.active_planner_graph_id = ''
    session.active_planner_snapshot_root = ''
    session.pending_project_review_reentry = None
    session.lsp_diagnostics.clear()
    session.lsp_workspace_root = ''
    session.lsp_active_scope = 'workspace'
