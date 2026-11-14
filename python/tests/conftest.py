"""Shared pytest fixtures for clara_coder_backend tests."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.lsp.manager import shutdown_session_lsp
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config, sessions


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


@pytest.fixture(autouse=True)
def _runtime_config_already_synced():
    """The app syncs Settings at startup; tests that start a server without a sync would wait for one."""
    from clara_coder_backend.session.state import runtime_config_received

    runtime_config_received.set()


@pytest.fixture(autouse=True)
def _reset_turns_and_subagents():
    """Per-session turn locks bind to the loop that first waited on them; tests each get a new loop.

    The sub-agent registry and its event bus (buffered events, subscribers) are process-wide too, and
    so is the session store: past its prune threshold, a ``get_session`` evicts a test's untouched session.
    """
    from clara_coder_backend.lang_agent.subagents import reset_subagents_for_tests
    from clara_coder_backend.session.turns import reset_turns_for_tests

    reset_turns_for_tests()
    reset_subagents_for_tests()
    sessions.clear()
    yield
    reset_turns_for_tests()
    reset_subagents_for_tests()
    sessions.clear()


@pytest.fixture(autouse=True)
def _no_real_typescript_language_server(monkeypatch):
    """Keep tests from starting a real TypeScript language server.

    A developer machine may have vtsls installed from Dependencies, or a workspace ``node_modules``
    with vtsls in it; an edit tool writing a ``.ts`` file would then start it, and on Windows a server
    killed after its startup timeout leaves a child process that keeps the temp workspace open. With
    nothing installed the plugin would raise ``LspServerNotInstalledError`` instead, so tests would
    depend on the machine. The plugin gets a command that does not exist: starting it fails at once,
    the edit tools report the LSP sync as failed and carry on, and tests that inject a fake client
    never run the command. ``test_typescript_lsp_command.py`` calls the real resolver directly.
    """
    from clara_coder_backend.lsp.typescript_server import TypescriptLspSpawn

    monkeypatch.setattr(
        'clara_coder_backend.lsp.plugins.typescript_plugin.resolve_typescript_lsp_spawn',
        lambda _root: TypescriptLspSpawn(['clara-tests-no-typescript-language-server', '--stdio']),
    )


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
    session.edits.journal_earlier_turns = {}
    session.hitl_sse_queue = None
    session.hitl_sse_loop = None
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
