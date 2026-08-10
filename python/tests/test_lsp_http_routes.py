"""HTTP route tests for Monaco LSP endpoints (blocking work runs off the event loop)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.lsp.manager import get_session_lsp_manager, shutdown_all_lsp_managers
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config


class _FakeLspClient:
    def __init__(self, *, command, workspace_root, notification_handler):
        self.command = command
        self.workspace_root = workspace_root
        self.notification_handler = notification_handler
        self.docs: dict[str, str] = {}
        self.closed = False
        self.initialized = False
        self.sync_notify_count = 0

    def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
        del root_uri, process_id, capabilities, initialization_options
        self.initialized = True
        return {
            'capabilities': {
                'semanticTokensProvider': {
                    'legend': {'tokenTypes': ['keyword'], 'tokenModifiers': ['declaration']},
                },
            },
        }

    def request(self, method, params, *, timeout_s=10.0):
        del timeout_s
        uri = params['textDocument']['uri']
        if method == 'textDocument/hover':
            return {'contents': 'hover: value'}
        if method == 'textDocument/definition':
            return [{'uri': uri, 'range': {'start': {'line': 0, 'character': 4}}}]
        if method == 'textDocument/references':
            return [{'uri': uri, 'range': {'start': {'line': 0, 'character': 0}}}]
        if method == 'textDocument/documentSymbol':
            return [
                {
                    'name': 'value',
                    'kind': 13,
                    'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 5}},
                    'selectionRange': {'start': {'line': 0, 'character': 4}, 'end': {'line': 0, 'character': 5}},
                    'children': [],
                }
            ]
        if method == 'textDocument/completion':
            return {'items': [{'label': 'fakeItem', 'kind': 1}], 'isIncomplete': False}
        if method == 'textDocument/rename':
            return None
        if method == 'textDocument/semanticTokens/full':
            return {'data': [0, 0, 2, 0, 1], 'resultId': None}
        if method == 'shutdown':
            self.closed = True
            return {}
        raise AssertionError(f'unexpected LSP method: {method}')

    def notify(self, method, params):
        if method == 'initialized':
            return
        if method == 'exit':
            self.closed = True
            return
        if method == 'textDocument/didClose':
            uri = params['textDocument']['uri']
            self.docs.pop(uri, None)
            self.notification_handler('textDocument/publishDiagnostics', {'uri': uri, 'diagnostics': []})
            return
        if method not in ('textDocument/didOpen', 'textDocument/didChange'):
            raise AssertionError(f'unexpected LSP notification: {method}')
        self.sync_notify_count += 1
        if method == 'textDocument/didOpen':
            uri = params['textDocument']['uri']
            text = params['textDocument']['text']
        else:
            uri = params['textDocument']['uri']
            text = params['contentChanges'][0]['text']
        self.docs[uri] = text
        diagnostics = []
        if 'TODO' in text:
            diagnostics.append(
                {
                    'range': {
                        'start': {'line': 0, 'character': 0},
                        'end': {'line': 0, 'character': 4},
                    },
                    'severity': 2,
                    'source': 'fake-lsp',
                    'code': 'TODO',
                    'message': 'Found TODO marker',
                }
            )
        self.notification_handler('textDocument/publishDiagnostics', {'uri': uri, 'diagnostics': diagnostics})

    def is_running(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True

    def shutdown(self):
        self.closed = True


@pytest.fixture()
def lsp_http_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    saved_tools = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    shutdown_all_lsp_managers()

    workspace = tmp_path / 'ws'
    workspace.mkdir()
    pkg = workspace / 'pkg'
    pkg.mkdir()
    sample = pkg / 'mod.py'
    sample.write_text('value = "TODO"\nprint(value)\n', encoding='utf-8')

    session_id = 'lsp-http-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    session.lsp_active_scope = 'workspace'
    session.lsp_workspace_root = ''

    fake_clients: list[_FakeLspClient] = []

    def factory(*, command, workspace_root, notification_handler, env=None):
        client = _FakeLspClient(
            command=command,
            workspace_root=workspace_root,
            notification_handler=notification_handler,
        )
        fake_clients.append(client)
        return client

    real_get = get_session_lsp_manager

    def _inject(*args, **kwargs):
        kwargs.setdefault('client_factory', factory)
        return real_get(*args, **kwargs)

    monkeypatch.setattr('clara_coder_backend.routes.lsp.get_session_lsp_manager', _inject)

    from clara_coder_backend.main import app

    yield SimpleNamespace(app=app, session_id=session_id, sample_path='pkg/mod.py', fake_clients=fake_clients)

    current_session_id.reset(token)
    shutdown_all_lsp_managers()
    runtime_config.tools = saved_tools


def test_lsp_hover_http_route(lsp_http_env) -> None:
    with TestClient(lsp_http_env.app) as client:
        r = client.post(
            f'/lsp/hover?session_id={lsp_http_env.session_id}',
            json={
                'relative_path': lsp_http_env.sample_path,
                'line': 1,
                'character': 1,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body['markdown']
    # No prior sync → manager fell back to disk-based sync_workspace_document.
    assert body['synced_from_disk'] is True


def test_lsp_hover_http_route_after_buffer_sync_reports_no_disk_fallback(lsp_http_env) -> None:
    with TestClient(lsp_http_env.app) as client:
        r = client.post(
            f'/lsp/hover?session_id={lsp_http_env.session_id}',
            json={
                'relative_path': lsp_http_env.sample_path,
                'line': 1,
                'character': 1,
                'document_text': 'const x = 1\n',
                'skip_document_sync': False,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body['markdown']
    # Buffer was synced explicitly → hover used the in-memory buffer, not disk.
    assert body['synced_from_disk'] is False


def test_lsp_definition_http_route(lsp_http_env) -> None:
    with TestClient(lsp_http_env.app) as client:
        r = client.post(
            f'/lsp/definition?session_id={lsp_http_env.session_id}',
            json={'relative_path': lsp_http_env.sample_path, 'line': 1, 'character': 1},
        )
    assert r.status_code == 200
    assert r.json()['locations']


def test_lsp_completion_http_route(lsp_http_env) -> None:
    with TestClient(lsp_http_env.app) as client:
        r = client.post(
            f'/lsp/completion?session_id={lsp_http_env.session_id}',
            json={
                'relative_path': lsp_http_env.sample_path,
                'line': 1,
                'character': 1,
                'trigger_kind': 1,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body.get('items')
    assert body['items'][0].get('label') == 'fakeItem'


def test_lsp_completion_accepts_explicit_empty_document_text(lsp_http_env) -> None:
    """Empty string buffer must be forwarded (unsaved empty editor), not treated as omitted."""
    with TestClient(lsp_http_env.app) as client:
        r = client.post(
            f'/lsp/completion?session_id={lsp_http_env.session_id}',
            json={
                'relative_path': lsp_http_env.sample_path,
                'line': 1,
                'character': 1,
                'trigger_kind': 1,
                'document_text': '',
            },
        )
    assert r.status_code == 200
    assert r.json().get('items')


def test_lsp_completion_skip_document_sync_avoids_second_buffer_sync(lsp_http_env) -> None:
    """``skip_document_sync`` must not send another didOpen/didChange for the same buffer."""
    text = 'value = "TODO"\nprint(value)\n'
    with TestClient(lsp_http_env.app) as client:
        r1 = client.post(
            f'/lsp/completion?session_id={lsp_http_env.session_id}',
            json={
                'relative_path': lsp_http_env.sample_path,
                'line': 1,
                'character': 1,
                'trigger_kind': 1,
                'document_text': text,
            },
        )
        assert r1.status_code == 200
        assert lsp_http_env.fake_clients, 'expected injected LSP client'
        fake = lsp_http_env.fake_clients[0]
        after_first = fake.sync_notify_count
        r2 = client.post(
            f'/lsp/completion?session_id={lsp_http_env.session_id}',
            json={
                'relative_path': lsp_http_env.sample_path,
                'line': 1,
                'character': 1,
                'trigger_kind': 1,
                'skip_document_sync': True,
            },
        )
        after_second = fake.sync_notify_count
    assert r2.status_code == 200
    assert after_second == after_first


def test_lsp_semantic_tokens_legend_python_deferred_without_seed(lsp_http_env) -> None:
    """Jedi is not started for legend prefetch until a ``.py`` file has been synced (seed)."""

    with TestClient(lsp_http_env.app) as client:
        r = client.get(
            f'/lsp/semantic-tokens-legend?session_id={lsp_http_env.session_id}&server=python',
        )
    assert r.status_code == 200
    data = r.json()
    assert data.get('supported') is False
    assert data.get('tokenTypes') == []


def test_lsp_semantic_tokens_legend_python_after_disk_sync_uses_injected_client(lsp_http_env) -> None:
    """After syncing a ``.py`` path, legend prefetch may start the injected Python client."""

    with TestClient(lsp_http_env.app) as client:
        r0 = client.get(
            f'/lsp/diagnostics?session_id={lsp_http_env.session_id}'
            f'&relative_path={lsp_http_env.sample_path}&refresh_active_document=true',
        )
        assert r0.status_code == 200
        r = client.get(
            f'/lsp/semantic-tokens-legend?session_id={lsp_http_env.session_id}&server=python',
        )
    assert r.status_code == 200
    data = r.json()
    assert data.get('supported') is True
    assert 'keyword' in data.get('tokenTypes', [])


def test_lsp_semantic_tokens_legend_typescript_deferred_without_seed(lsp_http_env) -> None:
    """TypeScript legend prefetch is deferred until a TS/JS file has been synced (seed)."""

    with TestClient(lsp_http_env.app) as client:
        r = client.get(
            f'/lsp/semantic-tokens-legend?session_id={lsp_http_env.session_id}&server=typescript',
        )
    assert r.status_code == 200
    data = r.json()
    assert data.get('supported') is False
    assert data.get('tokenTypes') == []
    assert not lsp_http_env.fake_clients


def test_lsp_semantic_tokens_legend_typescript_after_disk_sync_uses_injected_client(lsp_http_env) -> None:
    """After syncing a TS/JS path, legend prefetch may start the injected TypeScript client."""

    session = get_session(lsp_http_env.session_id)
    root = Path(session.workspace_path)
    ts = root / 'src' / 'app.ts'
    ts.parent.mkdir(parents=True, exist_ok=True)
    ts.write_text('export const x = 1\n', encoding='utf-8')
    with TestClient(lsp_http_env.app) as client:
        r0 = client.get(
            f'/lsp/diagnostics?session_id={lsp_http_env.session_id}'
            f'&relative_path=src/app.ts&refresh_active_document=true',
        )
        assert r0.status_code == 200
        r = client.get(
            f'/lsp/semantic-tokens-legend?session_id={lsp_http_env.session_id}&server=typescript',
        )
    assert r.status_code == 200
    data = r.json()
    assert data.get('supported') is True
    assert 'keyword' in data.get('tokenTypes', [])
    assert lsp_http_env.fake_clients
    assert lsp_http_env.fake_clients[0].initialized is True


def test_lsp_hover_bad_extension_returns_400(lsp_http_env) -> None:
    with TestClient(lsp_http_env.app) as client:
        r = client.post(
            f'/lsp/hover?session_id={lsp_http_env.session_id}',
            json={'relative_path': 'pkg/readme.xyz', 'line': 1, 'character': 1},
        )
    assert r.status_code == 400


def test_lsp_semantic_tokens_legend_unknown_server_returns_400(lsp_http_env) -> None:
    with TestClient(lsp_http_env.app) as client:
        r = client.get(
            f'/lsp/semantic-tokens-legend?session_id={lsp_http_env.session_id}&server=not-a-server',
        )
    assert r.status_code == 400


def test_lsp_semantic_tokens_legend_gdscript_default_bridge_deferred_without_seed(
    lsp_http_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Default GDScript bridge is not started for legend until a ``.gd`` file has been synced (seed)."""

    monkeypatch.delenv('CLARA_GDSCRIPT_LSP_COMMAND', raising=False)
    with TestClient(lsp_http_env.app) as client:
        r = client.get(
            f'/lsp/semantic-tokens-legend?session_id={lsp_http_env.session_id}&server=gdscript',
        )
    assert r.status_code == 200
    data = r.json()
    assert data.get('supported') is False
    assert data.get('tokenTypes') == []


def test_lsp_semantic_tokens_legend_gdscript_after_disk_sync_uses_injected_client(
    lsp_http_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After syncing a ``.gd`` path, legend prefetch may start the injected gdscript client."""

    monkeypatch.delenv('CLARA_GDSCRIPT_LSP_COMMAND', raising=False)
    session = get_session(lsp_http_env.session_id)
    root = Path(session.workspace_path)
    gd = root / 'game' / 'Main.gd'
    gd.parent.mkdir(parents=True, exist_ok=True)
    gd.write_text('extends Node\n', encoding='utf-8')
    with TestClient(lsp_http_env.app) as client:
        r0 = client.get(
            f'/lsp/diagnostics?session_id={lsp_http_env.session_id}'
            f'&relative_path=game/Main.gd&refresh_active_document=true',
        )
        assert r0.status_code == 200
        r = client.get(
            f'/lsp/semantic-tokens-legend?session_id={lsp_http_env.session_id}&server=gdscript',
        )
    assert r.status_code == 200
    data = r.json()
    assert data.get('supported') is True
    assert 'keyword' in data.get('tokenTypes', [])


def test_get_lsp_dashboard_status_includes_builtin_servers(lsp_http_env) -> None:
    from clara_coder_backend.lsp.manager import get_lsp_dashboard_status

    st = get_lsp_dashboard_status(lsp_http_env.session_id)
    servers = st.get('servers') or {}
    assert servers.get('python', {}).get('initialized') is False
    assert servers.get('typescript', {}).get('initialized') is False
    assert servers.get('gdscript', {}).get('initialized') is False
    assert servers.get('java', {}).get('initialized') is False


def test_get_lsp_dashboard_status_uses_cached_ts_root_only(lsp_http_env, tmp_path) -> None:
    from clara_coder_backend.lsp.manager import get_lsp_dashboard_status
    from clara_coder_backend.session.state import get_session

    session = get_session(lsp_http_env.session_id)
    session.typescript_lsp_resolved_root = ''

    st = get_lsp_dashboard_status(lsp_http_env.session_id)
    assert st.get('typescriptProjectRoot') is None
    assert st.get('nodeModulesPresent') is False

    workspace = tmp_path / 'ws2'
    pkg = workspace / 'pkg'
    pkg.mkdir(parents=True)
    (pkg / 'node_modules').mkdir()
    session.typescript_lsp_resolved_root = str(pkg.resolve())

    st2 = get_lsp_dashboard_status(lsp_http_env.session_id)
    assert st2.get('typescriptProjectRoot') == str(pkg.resolve())
    assert st2.get('nodeModulesPresent') is True


def test_lsp_warm_server_http_route(lsp_http_env) -> None:
    with TestClient(lsp_http_env.app) as client:
        r = client.post(f'/lsp/warm-server?session_id={lsp_http_env.session_id}&server=python')
    assert r.status_code == 200
    body = r.json()
    assert body.get('server') == 'python'
