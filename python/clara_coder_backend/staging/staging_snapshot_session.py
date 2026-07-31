"""Helpers to bootstrap and tear down the workspace mirror used for staging and LSP overlays."""

from __future__ import annotations

from pathlib import Path

from clara_coder_backend.staging import edit_staging
from clara_coder_backend.tools.review_tools import rollback_test_run_materializations
from clara_coder_backend.session.domain import SessionState
from clara_coder_backend.lsp.manager import shutdown_session_lsp


def prepare_new_staging_snapshot_session(session: SessionState, session_id: str) -> str:
    """Reset session-local staging/LSP state, then seed a fresh workspace snapshot."""
    shutdown_session_lsp(session_id)
    if session.test_run_materializations:
        rollback_test_run_materializations(session)
    session.pending_diff_payload = None
    session.pending_staged_transfer_hitl = None
    session.pending_staged_transfer_batch_payload = None
    session.pending_delete_request = None
    session.pending_copy_request = None
    session.pending_accept_command_request = None
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    session.lsp_workspace_root = ''
    session.typescript_lsp_resolved_root = ''
    session.lsp_active_scope = 'workspace'

    workspace_root = Path(session.workspace_path).resolve()
    if not workspace_root.is_dir():
        raise ValueError('This conversation does not have a workspace attached.')
    return edit_staging.begin_staging_snapshot_session(session, session_id, workspace_root)


def cleanup_staging_snapshot_session(session: SessionState, session_id: str) -> None:
    """Best-effort cleanup for staging snapshot state after an outer agent turn completes."""
    shutdown_session_lsp(session_id)
    if session.test_run_materializations:
        rollback_test_run_materializations(session)
    edit_staging.discard_all_session_stagings(session)
    edit_staging.clear_session_staging_dir(session_id)
    session.active_staging_snapshot_id = ''
    session.active_staging_snapshot_root = ''
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    session.lsp_workspace_root = ''
    session.typescript_lsp_resolved_root = ''
    session.lsp_active_scope = 'workspace'
