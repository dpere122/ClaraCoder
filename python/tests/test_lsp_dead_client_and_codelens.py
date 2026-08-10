"""Dead LSP client recovery and CodeLens resolve payload hardening."""

from __future__ import annotations

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
        return {'capabilities': {}}

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
        if method in ('textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose'):
            return
        raise AssertionError(f'unexpected LSP notification: {method}')

    def close(self) -> None:
        self.closed = True
        self.alive = False

    def shutdown(self) -> None:
        self.closed = True
        self.alive = False


@pytest.fixture(autouse=True)
def _reset_lsp_state():
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
