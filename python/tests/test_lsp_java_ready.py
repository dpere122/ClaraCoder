"""Java LSP language/status readiness wait (no live JDT process)."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from clara_coder_backend.lsp.manager import (
    SessionWorkspaceLspManager,
    java_workspace_is_ready,
    shutdown_all_lsp_managers,
)
from clara_coder_backend.session.state import current_session_id, get_session


def test_java_workspace_is_ready_statuses() -> None:
    assert java_workspace_is_ready('Started') is True
    assert java_workspace_is_ready('ServiceReady') is True
    assert java_workspace_is_ready('ProjectStatus', 'OK') is True
    assert java_workspace_is_ready('ProjectStatus', 'Ready') is True
    assert java_workspace_is_ready('Starting') is False
    assert java_workspace_is_ready('ProjectStatus', 'Error') is False
    assert java_workspace_is_ready('') is False


def _java_manager(tmp_path: Path, session_id: str) -> tuple[SessionWorkspaceLspManager, object]:
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    mgr = SessionWorkspaceLspManager(
        session_id=session_id,
        session=session,
        workspace_root=workspace,
        scope='workspace',
        server_kind='java',
        client_factory=lambda **kwargs: (_ for _ in ()).throw(AssertionError('should not spawn')),
    )
    return mgr, token


def test_wait_for_java_ready_treats_projectstatus_ok(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _java_manager(tmp_path, 'java-ready-projectstatus')
    try:
        mgr._handle_notification('language/status', {'type': 'ProjectStatus', 'message': 'OK'})
        started = time.monotonic()
        mgr._wait_for_java_workspace_ready(timeout_s=8.0)
        assert time.monotonic() - started < 0.5
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_wait_for_java_ready_treats_started(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _java_manager(tmp_path, 'java-ready-started')
    try:
        mgr._handle_notification('language/status', {'type': 'Started', 'message': 'Ready'})
        started = time.monotonic()
        mgr._wait_for_java_workspace_ready(timeout_s=8.0)
        assert time.monotonic() - started < 0.5
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


def test_wait_for_java_ready_does_not_block_long_on_starting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import clara_coder_backend.lsp.manager as lsp_manager

    monkeypatch.setattr(lsp_manager, '_JAVA_STARTING_GRACE_S', 0.3)
    shutdown_all_lsp_managers()
    mgr, token = _java_manager(tmp_path, 'java-ready-starting')
    try:
        mgr._handle_notification('language/status', {'type': 'Starting', 'message': 'Init'})
        started = time.monotonic()
        mgr._wait_for_java_workspace_ready(timeout_s=60.0)
        elapsed = time.monotonic() - started
        assert elapsed < 1.5
        assert elapsed >= 0.25
    finally:
        current_session_id.reset(token)
        shutdown_all_lsp_managers()


class _FakeJdtClient:
    def __init__(self, *, root: Path, command: list[str], notification_handler) -> None:
        self.root = root
        self.command = command
        self.notification_handler = notification_handler
        self.init_options: dict | None = None
        self.closed = False

    def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
        del root_uri, process_id, capabilities
        self.init_options = initialization_options
        return {'capabilities': {'textDocumentSync': {'openClose': True, 'change': 1}}}

    def notify(self, method, params):
        if method in ('textDocument/didOpen', 'textDocument/didChange'):
            uri = params['textDocument']['uri']
            self.notification_handler('textDocument/publishDiagnostics', {'uri': uri, 'diagnostics': []})

    def is_running(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True

    def shutdown(self) -> None:
        self.closed = True


def test_build_file_restart_starts_new_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Adding a build file restarts JDT LS in place; the manager must not stay ``shuttingDown``."""

    from clara_coder_backend.lsp.plugins import java_plugin as java_plugin_mod

    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
    monkeypatch.setattr(
        java_plugin_mod,
        'build_java_lsp_command',
        lambda root, instance_key='': ['jdtls', instance_key],
    )
    shutdown_all_lsp_managers()
    workspace = tmp_path / 'ws'
    (workspace / 'src' / 'journal').mkdir(parents=True)
    source = 'package journal;\nclass App {}\n'
    (workspace / 'src' / 'journal' / 'App.java').write_text(source, encoding='utf-8')
    token = current_session_id.set('java-restart-kind')
    session = get_session('java-restart-kind')
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    clients: list[_FakeJdtClient] = []

    def factory(*, command, workspace_root, notification_handler, env=None):
        del env
        client = _FakeJdtClient(root=workspace_root, command=command, notification_handler=notification_handler)
        clients.append(client)
        return client

    mgr = SessionWorkspaceLspManager(
        session_id='java-restart-kind',
        session=session,
        workspace_root=workspace,
        scope='workspace',
        server_kind='java',
        client_factory=factory,
    )
    try:
        mgr.sync_document('src/journal/App.java', source, wait_for_diagnostics=False)
        assert [c.command[-1] for c in clients] == ['java-restart-kind:workspace:loose']
        assert clients[0].init_options['settings']['java']['project'] == {'sourcePaths': ['src']}

        (workspace / 'build.gradle.kts').write_text('plugins { java }\n', encoding='utf-8')
        mgr.sync_document('src/journal/App.java', source + '\n', wait_for_diagnostics=False)
        assert [c.command[-1] for c in clients] == [
            'java-restart-kind:workspace:loose',
            'java-restart-kind:workspace:gradle',
        ]
        assert clients[0].closed is True
        assert 'project' not in clients[1].init_options['settings']['java']
        assert mgr.lifecycle_phase() != 'shuttingDown'
        assert mgr.is_client_running() is True
    finally:
        current_session_id.reset(token)
        mgr.shutdown()
        shutdown_all_lsp_managers()


def test_pending_java_configuration_is_pushed_to_client(tmp_path: Path) -> None:
    shutdown_all_lsp_managers()
    mgr, token = _java_manager(tmp_path, 'java-push-config')
    pushed: list[dict] = []

    class _Client:
        def update_configuration(self, options: dict) -> None:
            pushed.append(options)

    try:
        mgr._client = _Client()  # type: ignore[assignment]
        mgr._plugin_state.pending_options = {'settings': {'java': {'project': {'sourcePaths': ['src']}}}}
        mgr._push_pending_configuration()
        mgr._push_pending_configuration()
        assert pushed == [{'settings': {'java': {'project': {'sourcePaths': ['src']}}}}]
    finally:
        mgr._client = None
        current_session_id.reset(token)
        shutdown_all_lsp_managers()
