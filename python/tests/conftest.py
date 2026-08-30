"""Shared pytest fixtures for clara_coder_backend tests."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.lsp.manager import shutdown_session_lsp
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config


@pytest.fixture(autouse=True)
def _sidecar_auth_optional(monkeypatch):
    """Default the suite to sidecar-auth-optional so existing no-token route tests pass.

    The FastAPI ``SidecarBearerAuthMiddleware`` (security/python-sidecar-auth) is
    fail-closed when ``CLARA_SIDECAR_TOKEN`` is set and ``CLARA_SIDECAR_AUTH_OPTIONAL``
    is not. Most legacy tests hit routes without a bearer token, so opt out of
    auth by default here. Tests that exercise the auth gate live in
    ``tests/security_sidecar_auth/test_sidecar_auth.py`` and override this by
    setting ``CLARA_SIDECAR_TOKEN`` and deleting ``CLARA_SIDECAR_AUTH_OPTIONAL``
    in their own ``auth_on`` fixture.
    """
    monkeypatch.setenv('CLARA_SIDECAR_AUTH_OPTIONAL', '1')


@pytest.fixture()
def staging_env():
    saved_staging = os.environ.get('CLARA_STAGING_DIR')
    saved_tools = runtime_config.tools

    td = tempfile.TemporaryDirectory()
    td_path = Path(td.name)
    staging_root = td_path / 'staging'
    staging_root.mkdir(parents=True)
    os.environ['CLARA_STAGING_DIR'] = str(staging_root)

    workspace = td_path / 'ws'
    workspace.mkdir()

    session_id = 'test-staging-session'
    token = current_session_id.set(session_id)
    # Drop any LSP managers/overlays left by prior tests that reuse this session id.
    shutdown_session_lsp(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.pending_edit_stagings.clear()
    session.pending_diff_payload = None
    session.auto_apply_mode = False
    session.worker_apply_mode = True
    session.abort_event.clear()
    session.planning_nested_events_q = None
    session.lsp_staging_overlay_root = ''
    session.lsp_staging_overlay_parent = ''
    session.active_staging_snapshot_id = ''
    session.active_staging_snapshot_root = ''
    session.lsp_active_scope = 'workspace'
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}

    runtime_config.tools = RuntimeToolsConfig(
        edit_tools_strict=False,
        max_file_read_lines=400,
        max_search_results=40,
    )

    class _Env:
        pass

    env = _Env()
    env.staging_root = staging_root  # type: ignore[attr-defined]
    env.workspace = workspace  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]
    env.session_id = session_id  # type: ignore[attr-defined]

    yield env

    from clara_coder_backend.tools.write_jobs import cancel_write_job, write_jobs

    for job in list(write_jobs().values()):
        if job.session_id == session_id:
            cancel_write_job(job)
    shutdown_session_lsp(session_id)
    current_session_id.reset(token)
    if saved_staging is None:
        os.environ.pop('CLARA_STAGING_DIR', None)
    else:
        os.environ['CLARA_STAGING_DIR'] = saved_staging
    runtime_config.tools = saved_tools
    td.cleanup()
