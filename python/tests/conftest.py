"""Shared pytest fixtures for clara_coder_backend tests."""

from __future__ import annotations

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
def workspace_env():
    """Editor-mode session with a temp workspace for the write-through edit tools."""
    saved_tools = runtime_config.tools

    td = tempfile.TemporaryDirectory()
    workspace = Path(td.name) / 'ws'
    workspace.mkdir()

    session_id = 'test-workspace-session'
    token = current_session_id.set(session_id)
    # Drop any LSP managers left by prior tests that reuse this session id.
    shutdown_session_lsp(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.auto_apply_mode = False
    session.worker_apply_mode = True
    session.current_user_message_id = 'turn-1'
    session.edits.journal_turn_id = ''
    session.edits.journaled_paths = set()
    session.hitl_sse_queue = None
    session.abort_event.clear()
    session.planning_nested_events_q = None
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
    env.workspace = workspace  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]
    env.session_id = session_id  # type: ignore[attr-defined]

    yield env

    shutdown_session_lsp(session_id)
    current_session_id.reset(token)
    runtime_config.tools = saved_tools
    td.cleanup()
