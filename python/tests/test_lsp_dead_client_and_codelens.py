"""Dead LSP client recovery and CodeLens resolve payload hardening."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.lsp.editor_monaco import monaco_code_lens_to_lsp, serialize_code_lenses_payload
from clara_coder_backend.lsp.manager import SessionWorkspaceLspManager, shutdown_all_lsp_managers
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config


class _FakeLspClient:
    def __init__(self, *, command, workspace_root, notification_handler, env=None):
        del env
        self.command = command
        self.workspace_root = workspace_root
        self.notification_handler = notification_handler
        self.alive = True
        self.closed = False
        self.initialized = False
        self.resolve_calls: list[dict] = []

    def is_running(self) -> bool:
        return self.alive and not self.closed

    def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
        del root_uri, process_id, capabilities, initialization_options
        self.initialized = True
        return {'capabilities': {'codeLensProvider': {'resolveProvider': True}}}

    def request(self, method, params, *, timeout_s=10.0):
        del timeout_s
        if method == 'codeLens/resolve':
            self.resolve_calls.append(params)
            out = dict(params)
            out['command'] = {'title': 'refs', 'command': 'java.show.references', 'arguments': []}
            return out
        if method == 'shutdown':
            self.closed = True
            return {}
        raise AssertionError(f'unexpected LSP method: {method}')

    def notify(self, method, params):
        del params
        if method in ('initialized', 'exit'):
            if method == 'exit':
                self.closed = True
            return
        if method in ('textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'workspace/didChangeWatchedFiles', 'textDocument/didSave'):
            return
        raise AssertionError(f'unexpected LSP notification: {method}')

    def close(self) -> None:
        self.closed = True
        self.alive = False

    def shutdown(self) -> None:
        self.closed = True
        self.alive = False


@pytest.fixture(autouse=True)
def _reset_lsp_state(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('CLARA_PYTHON_LSP_COMMAND', 'fake-python-lsp --stdio')
    saved_tools = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    shutdown_all_lsp_managers()
    yield
    shutdown_all_lsp_managers()
    runtime_config.tools = saved_tools


def test_monaco_code_lens_to_lsp_converts_irange_and_keeps_data() -> None:
    lsp = monaco_code_lens_to_lsp(
        {
            'range': {
                'startLineNumber': 12,
                'startColumn': 3,
                'endLineNumber': 12,
                'endColumn': 10,
            },
            'data': [1, 2, 3],
        }
    )
    assert lsp == {
        'range': {
            'start': {'line': 11, 'character': 2},
            'end': {'line': 11, 'character': 9},
        },
        'data': [1, 2, 3],
    }


def test_serialize_code_lenses_preserves_data() -> None:
    rows = serialize_code_lenses_payload(
        [
            {
                'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 4}},
                'data': {'uri': 'file:///Game.java'},
            }
        ]
    )
    assert rows[0]['data'] == {'uri': 'file:///Game.java'}


def test_code_lens_resolve_skips_roundtrip_when_data_missing(tmp_path: Path) -> None:
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    (workspace / 'pkg').mkdir()
    (workspace / 'pkg' / 'mod.py').write_text('value = 1\n', encoding='utf-8')

    session_id = 'codelens-skip'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    try:
        clients: list[_FakeLspClient] = []

        def factory(**kwargs):
            client = _FakeLspClient(**kwargs)
            clients.append(client)
            return client

        mgr = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=workspace,
            scope='workspace',
            server_kind='python',
            client_factory=factory,
        )
        out = mgr.code_lens_resolve(
            {
                'range': {
                    'startLineNumber': 1,
                    'startColumn': 1,
                    'endLineNumber': 1,
                    'endColumn': 5,
                }
            }
        )
        assert 'data' not in out
        assert out['range']['start']['line'] == 0
        assert clients == []
    finally:
        current_session_id.reset(token)


def test_dead_client_marked_not_running_and_ensure_started_respawns(tmp_path: Path) -> None:
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    (workspace / 'pkg').mkdir()
    (workspace / 'pkg' / 'mod.py').write_text('value = 1\n', encoding='utf-8')

    session_id = 'dead-client-restart'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {
        'workspace': {
            'pkg/mod.py': [
                {
                    'relative_path': 'pkg/mod.py',
                    'message': 'stale',
                    'severity': 'error',
                    'severity_value': 1,
                    'code': '1',
                    'source': 'py',
                    'line': 1,
                    'character': 1,
                    'end_line': 1,
                    'end_character': 2,
                }
            ]
        },
        'staging': {},
    }
    try:
        clients: list[_FakeLspClient] = []

        def factory(**kwargs):
            client = _FakeLspClient(**kwargs)
            clients.append(client)
            return client

        mgr = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=workspace,
            scope='workspace',
            server_kind='python',
            client_factory=factory,
        )
        mgr.ensure_started()
        assert mgr.is_client_running() is True
        assert len(clients) == 1
        mgr._doc_versions['pkg/mod.py'] = 1

        # Simulate language server dying while the manager still holds the client object.
        clients[0].alive = False
        clients[0].closed = True
        assert mgr.is_client_running() is False

        mgr.ensure_started()
        assert mgr.is_client_running() is True
        assert len(clients) == 2
        assert clients[0].closed is True
        assert clients[1].initialized is True
        # Fresh server must re-open documents (versions cleared on death).
        assert mgr._doc_versions == {}
        assert 'pkg/mod.py' not in session.lsp_diagnostics_by_scope['workspace']
    finally:
        current_session_id.reset(token)


def test_code_lens_resolve_forwards_converted_payload_with_data(tmp_path: Path) -> None:
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    (workspace / 'pkg').mkdir()
    (workspace / 'pkg' / 'mod.py').write_text('value = 1\n', encoding='utf-8')

    session_id = 'codelens-resolve-ok'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    try:
        clients: list[_FakeLspClient] = []

        def factory(**kwargs):
            client = _FakeLspClient(**kwargs)
            clients.append(client)
            return client

        mgr = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=workspace,
            scope='workspace',
            server_kind='python',
            client_factory=factory,
        )
        result = mgr.code_lens_resolve(
            {
                'range': {
                    'startLineNumber': 2,
                    'startColumn': 1,
                    'endLineNumber': 2,
                    'endColumn': 4,
                },
                'data': [9, 8, 7],
            }
        )
        assert clients[0].resolve_calls == [
            {
                'range': {
                    'start': {'line': 1, 'character': 0},
                    'end': {'line': 1, 'character': 3},
                },
                'data': [9, 8, 7],
            }
        ]
        assert result['command']['command'] == 'java.show.references'
    finally:
        current_session_id.reset(token)


def test_code_lens_returns_empty_when_server_omits_provider(tmp_path: Path) -> None:
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    (workspace / 'pkg').mkdir()
    (workspace / 'pkg' / 'mod.py').write_text('value = 1\n', encoding='utf-8')

    session_id = 'codelens-unsupported'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    try:
        def factory(**kwargs):
            client = _FakeLspClient(**kwargs)
            orig = client.initialize

            def initialize(**kw):
                orig(**kw)
                return {'capabilities': {}}

            client.initialize = initialize  # type: ignore[method-assign]
            return client

        mgr = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=workspace,
            scope='workspace',
            server_kind='python',
            client_factory=factory,
        )
        mgr.ensure_started()
        mgr._doc_versions['pkg/mod.py'] = 1
        assert mgr.code_lens('pkg/mod.py') == []
    finally:
        current_session_id.reset(token)


def test_ensure_started_closes_client_when_initialize_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('CLARA_PYTHON_LSP_COMMAND', 'fake-python-lsp --stdio')
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    (workspace / 'pkg').mkdir()
    (workspace / 'pkg' / 'mod.py').write_text('value = 1\n', encoding='utf-8')

    session_id = 'init-fail-close'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    try:
        clients: list[_FakeLspClient] = []
        attempts = {'n': 0}

        class _FailOnceClient(_FakeLspClient):
            def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
                attempts['n'] += 1
                if attempts['n'] == 1:
                    raise TimeoutError("LSP request timed out for 'initialize' after 90.0s (process=None).")
                return super().initialize(
                    root_uri=root_uri,
                    process_id=process_id,
                    capabilities=capabilities,
                    initialization_options=initialization_options,
                )

        def factory(**kwargs):
            client = _FailOnceClient(**kwargs)
            clients.append(client)
            return client

        mgr = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=workspace,
            scope='workspace',
            server_kind='python',
            client_factory=factory,
        )
        with pytest.raises(TimeoutError, match='initialize'):
            mgr.ensure_started()
        assert len(clients) == 1
        assert clients[0].closed is True
        assert mgr._client is None
        assert mgr.is_client_running() is False

        mgr.ensure_started()
        assert len(clients) == 2
        assert mgr.is_client_running() is True
        assert clients[1].initialized is True
        assert clients[1].closed is False
    finally:
        current_session_id.reset(token)


def test_ensure_started_allows_language_status_during_initialize(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """JDT emits ``language/status`` before initialize returns; that must not deadlock."""

    monkeypatch.setenv('CLARA_PYTHON_LSP_COMMAND', 'fake-python-lsp --stdio')
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    (workspace / 'pkg').mkdir()
    (workspace / 'pkg' / 'mod.py').write_text('value = 1\n', encoding='utf-8')

    session_id = 'init-status-notify'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    try:
        class _NotifyDuringInitClient(_FakeLspClient):
            def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
                del root_uri, process_id, capabilities, initialization_options
                done = threading.Event()
                handler = self.notification_handler

                def emit() -> None:
                    handler('language/status', {'type': 'Starting', 'message': 'Init'})
                    done.set()

                threading.Thread(target=emit, daemon=True).start()
                if not done.wait(timeout=3.0):
                    raise TimeoutError(
                        'language/status notification deadlocked on manager lock during initialize'
                    )
                self.initialized = True
                return {'capabilities': {}}

        mgr = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=workspace,
            scope='workspace',
            server_kind='python',
            client_factory=lambda **kwargs: _NotifyDuringInitClient(**kwargs),
        )
        mgr.ensure_started()
        assert mgr.is_client_running() is True
        assert mgr._language_status == 'Starting'
        assert mgr._language_status_message == 'Init'
    finally:
        current_session_id.reset(token)


def test_concurrent_ensure_started_spawns_one_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('CLARA_PYTHON_LSP_COMMAND', 'fake-python-lsp --stdio')
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    (workspace / 'pkg').mkdir()
    (workspace / 'pkg' / 'mod.py').write_text('value = 1\n', encoding='utf-8')

    session_id = 'init-concurrent'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    try:
        clients: list[_FakeLspClient] = []
        started = threading.Event()
        release = threading.Event()

        class _SlowInitClient(_FakeLspClient):
            def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
                started.set()
                if not release.wait(timeout=3.0):
                    raise TimeoutError('concurrent ensure_started waiter did not arrive')
                return super().initialize(
                    root_uri=root_uri,
                    process_id=process_id,
                    capabilities=capabilities,
                    initialization_options=initialization_options,
                )

        def factory(**kwargs):
            client = _SlowInitClient(**kwargs)
            clients.append(client)
            return client

        mgr = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=workspace,
            scope='workspace',
            server_kind='python',
            client_factory=factory,
        )
        errors: list[BaseException] = []

        def run() -> None:
            try:
                mgr.ensure_started()
            except BaseException as exc:  # noqa: BLE001 — collect for assertion
                errors.append(exc)

        t1 = threading.Thread(target=run)
        t2 = threading.Thread(target=run)
        t1.start()
        assert started.wait(timeout=3.0)
        t2.start()
        # Give the second caller time to block in ensure_started before finishing init.
        threading.Event().wait(0.05)
        release.set()
        t1.join(timeout=3.0)
        t2.join(timeout=3.0)
        assert errors == []
        assert len(clients) == 1
        assert mgr.is_client_running() is True
    finally:
        current_session_id.reset(token)

