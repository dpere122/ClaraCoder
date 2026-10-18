"""Tests for the Python LSP manager, tools, and diagnostics routes."""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from clara_coder_backend.logging.app_logging import configure_logging, get_recent_records, reset_logging_handlers
from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.lsp.manager import (
    activate_session_lsp_scope,
    get_session_lsp_manager,
    shutdown_all_lsp_managers,
    shutdown_session_lsp,
    sync_session_document,
)
from clara_coder_backend.tools.lsp_tools import (
    lsp_find_definition,
    lsp_find_references,
    lsp_get_diagnostics,
    lsp_get_document_symbols,
    lsp_hover,
)
from clara_coder_backend.routes.session import clear_session, set_workspace_context
from clara_coder_backend.routes.lsp import lsp_diagnostics
from clara_coder_backend.session.schemas import ClearRequest, WorkspaceContextRequest
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config


class _FakeLspClient:
    def __init__(self, *, command, workspace_root, notification_handler):
        self.command = command
        self.workspace_root = workspace_root
        self.notification_handler = notification_handler
        self.docs: dict[str, str] = {}
        self.closed = False
        self.initialized = False

    def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):
        del root_uri, process_id, capabilities, initialization_options
        self.initialized = True
        return {'capabilities': {}}

    def request(self, method, params, *, timeout_s=10.0):
        del timeout_s
        uri = params['textDocument']['uri']
        if method == 'textDocument/hover':
            return {'contents': 'hover: value'}
        if method == 'textDocument/definition':
            return [{'uri': uri, 'range': {'start': {'line': 0, 'character': 4}}}]
        if method == 'textDocument/references':
            return [
                {'uri': uri, 'range': {'start': {'line': 0, 'character': 0}}},
                {'uri': uri, 'range': {'start': {'line': 1, 'character': 7}}},
            ]
        if method == 'textDocument/documentSymbol':
            return [
                {
                    'name': 'value',
                    'kind': 13,
                    'range': {'start': {'line': 0, 'character': 0}},
                    'selectionRange': {'start': {'line': 0, 'character': 4}},
                    'children': [],
                }
            ]
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
        if method in ('workspace/didChangeWatchedFiles', 'textDocument/didSave'):
            return
        if method not in ('textDocument/didOpen', 'textDocument/didChange'):
            raise AssertionError(f'unexpected LSP notification: {method}')
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


@pytest.fixture(autouse=True)
def _reset_lsp_state():
    saved_tools = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
    shutdown_all_lsp_managers()
    yield
    shutdown_all_lsp_managers()
    runtime_config.tools = saved_tools


@pytest.fixture()
def lsp_env(tmp_path: Path):
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    file_path = workspace / 'pkg'
    file_path.mkdir()
    sample = file_path / 'mod.py'
    sample.write_text('value = "TODO"\nprint(value)\n', encoding='utf-8')

    session_id = 'lsp-tools-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(workspace.resolve())
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    session.lsp_active_scope = 'workspace'
    session.lsp_workspace_root = ''

    factory = lambda *, command, workspace_root, notification_handler, env=None: _FakeLspClient(
        command=command,
        workspace_root=workspace_root,
        notification_handler=notification_handler,
    )
    manager = get_session_lsp_manager(session_id, client_factory=factory)

    class _Env:
        pass

    env = _Env()
    env.session_id = session_id  # type: ignore[attr-defined]
    env.session = session  # type: ignore[attr-defined]
    env.workspace = workspace  # type: ignore[attr-defined]
    env.sample = sample  # type: ignore[attr-defined]
    env.manager = manager  # type: ignore[attr-defined]
    env.factory = factory  # type: ignore[attr-defined]
    yield env
    current_session_id.reset(token)


def test_manager_syncs_python_document_and_caches_diagnostics(lsp_env) -> None:
    diagnostics = lsp_env.manager.sync_workspace_document('pkg/mod.py')
    assert len(diagnostics) == 1
    assert diagnostics[0]['severity'] == 'warning'
    assert diagnostics[0]['relative_path'] == 'pkg/mod.py'
    assert lsp_env.session.lsp_active_scope == 'workspace'
    assert lsp_env.session.lsp_workspace_root.endswith('ws')


def test_lsp_scope_managers_coexist_for_workspace_and_staging(lsp_env) -> None:
    staging_manager = get_session_lsp_manager(lsp_env.session_id, client_factory=lsp_env.factory, scope='staging')
    staging_manager.sync_document('pkg/mod.py', 'value = "TODO"\n')

    assert lsp_env.session.lsp_active_scope == 'staging'
    assert staging_manager._client is not None
    assert lsp_env.session.lsp_diagnostics_by_scope['staging']

    activate_session_lsp_scope(lsp_env.session_id, scope='workspace')

    assert lsp_env.session.lsp_active_scope == 'workspace'
    # Activating a scope no longer tears down the other scope's manager/cache.
    assert lsp_env.session.lsp_diagnostics_by_scope['staging']
    assert staging_manager._client is not None

    workspace_manager = get_session_lsp_manager(
        lsp_env.session_id, client_factory=lsp_env.factory, scope='workspace'
    )
    assert workspace_manager.scope == 'workspace'
    assert workspace_manager is not staging_manager
    assert staging_manager._client is not None


def test_typescript_lsp_read_tools(monkeypatch, lsp_env) -> None:
    (lsp_env.workspace / 'app.ts').write_text('const x = 1;\n', encoding='utf-8')

    def _inject(*a, **kwargs):
        kwargs.setdefault('client_factory', lsp_env.factory)
        return get_session_lsp_manager(*a, **kwargs)

    monkeypatch.setattr('clara_coder_backend.tools.lsp_tools.get_session_lsp_manager', _inject)

    diag_text = lsp_get_diagnostics.invoke({'relative_path': 'app.ts', 'refresh_active_document': True})
    assert 'LSP context:' in diag_text
    assert 'scope=workspace' in diag_text
    assert 'analyzed=workspace_file' in diag_text
    assert 'No LSP diagnostics for `app.ts`' in diag_text or '0 issue' in diag_text
    hover_text = lsp_hover.invoke({'relative_path': 'app.ts', 'line': 1, 'character': 8})
    assert 'hover: value' in hover_text


def test_lsp_tools_render_expected_outputs(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')

    diag_text = lsp_get_diagnostics.invoke({'relative_path': 'pkg/mod.py'})
    hover_text = lsp_hover.invoke({'relative_path': 'pkg/mod.py', 'line': 1, 'character': 1})
    def_text = lsp_find_definition.invoke({'relative_path': 'pkg/mod.py', 'line': 1, 'character': 1})
    ref_text = lsp_find_references.invoke({'relative_path': 'pkg/mod.py', 'line': 1, 'character': 1})
    sym_text = lsp_get_document_symbols.invoke({'relative_path': 'pkg/mod.py'})

    assert 'LSP context:' in diag_text
    assert 'scope=workspace' in diag_text
    assert 'analyzed=cached' in diag_text
    assert 'Found TODO marker' in diag_text
    assert 'hover: value' in hover_text
    assert '`pkg/mod.py`:1:5' in def_text
    assert '`pkg/mod.py`:2:8' in ref_text
    assert 'value (kind=13, line=1)' in sym_text


def test_lsp_get_diagnostics_returns_tool_error_when_lsp_bootstrap_fails(monkeypatch, lsp_env) -> None:
    class _BrokenManager:
        def get_diagnostics(self, relative_path: str = '') -> list[dict[str, object]]:
            del relative_path
            return []

        def sync_workspace_document(self, relative_path: str, *, encoding: str = 'utf-8') -> list[dict[str, object]]:
            del relative_path, encoding
            raise RuntimeError("LSP request failed for 'initialize': LSP client closed")

    monkeypatch.setattr('clara_coder_backend.tools.lsp_tools.get_session_lsp_manager', lambda *a, **k: _BrokenManager())

    result = lsp_get_diagnostics.invoke({'relative_path': 'pkg/mod.py', 'refresh_active_document': True})

    assert result.startswith('Tool error: Python LSP diagnostics lookup failed for `pkg/mod.py`')
    assert 'configured language server' in result


def test_sync_session_document_retry_restarts_only_failed_server(monkeypatch, lsp_env) -> None:
    class _BrokenOnceManager:
        def sync_document(self, relative_path: str, text: str, *, wait_for_diagnostics: bool = True):
            del relative_path, text, wait_for_diagnostics
            raise RuntimeError("LSP request failed for 'initialize': LSP client closed")

    class _RecoveredManager:
        def sync_document(self, relative_path: str, text: str, *, wait_for_diagnostics: bool = True):
            del relative_path, text, wait_for_diagnostics
            return [{'relative_path': 'pkg/mod.py', 'message': 'ok'}]

    managers = [_BrokenOnceManager(), _RecoveredManager()]
    shutdown_calls: list[tuple[str, str]] = []

    def _fake_get_session_lsp_manager(*args, **kwargs):
        del args, kwargs
        return managers.pop(0)

    def _fake_shutdown_session_lsp_server(session_id: str, server_id: str) -> None:
        shutdown_calls.append((session_id, server_id))

    monkeypatch.setattr('clara_coder_backend.lsp.manager.get_session_lsp_manager', _fake_get_session_lsp_manager)
    monkeypatch.setattr('clara_coder_backend.lsp.manager.shutdown_session_lsp_server', _fake_shutdown_session_lsp_server)
    monkeypatch.setattr(
        'clara_coder_backend.lsp.manager.shutdown_session_lsp',
        lambda session_id: (_ for _ in ()).throw(AssertionError(f'should not shut down all LSPs: {session_id}')),
    )

    diagnostics = sync_session_document('pkg/mod.py', 'value = 1\n', session_id=lsp_env.session_id)

    assert diagnostics == [{'relative_path': 'pkg/mod.py', 'message': 'ok'}]
    assert shutdown_calls == [(lsp_env.session_id, 'python')]


def test_diagnostics_route_returns_cached_python_results(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')
    payload = asyncio.run(lsp_diagnostics(session_id=lsp_env.session_id, relative_path='pkg/mod.py'))
    assert payload['relativePath'] == 'pkg/mod.py'
    assert payload.get('server') == 'python'
    diagnostics = payload['diagnostics']
    assert isinstance(diagnostics, list)
    assert diagnostics[0]['source'] == 'fake-lsp'


def test_diagnostics_route_refresh_alias_refresh_from_workspace(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')
    payload = asyncio.run(
        lsp_diagnostics(
            session_id=lsp_env.session_id,
            relative_path='pkg/mod.py',
            refresh_from_workspace=True,
        )
    )
    assert payload['relativePath'] == 'pkg/mod.py'
    assert isinstance(payload['diagnostics'], list)


def test_workspace_context_change_clears_lsp_session(lsp_env, tmp_path: Path) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')
    lsp_env.session.typescript_lsp_resolved_root = '/old/ts'
    lsp_env.session.java_lsp_resolved_root = '/old/java'
    next_workspace = tmp_path / 'next-ws'
    next_workspace.mkdir()
    asyncio.run(
        set_workspace_context(
            WorkspaceContextRequest(
                session_id=lsp_env.session_id,
                workspace_path=str(next_workspace.resolve()),
                workspace_context='',
            )
        )
    )
    assert lsp_env.session.lsp_diagnostics_by_scope == {'workspace': {}, 'staging': {}}
    assert lsp_env.session.lsp_workspace_root == ''
    assert lsp_env.session.typescript_lsp_resolved_root == ''
    assert lsp_env.session.java_lsp_resolved_root == ''


def test_clear_session_shuts_down_lsp_state(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')
    asyncio.run(clear_session(ClearRequest(session_id=lsp_env.session_id)))
    session = get_session(lsp_env.session_id)
    assert session.lsp_diagnostics_by_scope == {'workspace': {}, 'staging': {}}
    assert session.workspace_path == ''


def test_post_edit_checks_footer_steers_on_indent_diagnostics() -> None:
    from clara_coder_backend.lsp.diagnostics import post_edit_checks_footer

    saved = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(enable_agent_formatters=True)
    try:
        diags = [
            {
                'message': 'unexpected indent',
                'line': 2,
                'character': 1,
                'severity': 'error',
                'severity_value': 1,
                'code': '',
                'source': 'Pyright',
                'end_line': 2,
                'end_character': 5,
                'relative_path': 'pkg/x.py',
            }
        ]
        out = post_edit_checks_footer(
            'pkg/x.py',
            diags,
            lsp_scope='workspace',
            server_kind='python',
            formatter_lines=['Formatter (Black): applied.'],
        )
        assert 'Steer (indentation-like diagnostics detected)' in out
        assert 'Black already ran' in out
    finally:
        runtime_config.tools = saved


def test_post_edit_checks_footer_omits_format_tools_when_disabled() -> None:
    from clara_coder_backend.lsp.diagnostics import post_edit_checks_footer

    saved = runtime_config.tools
    runtime_config.tools = RuntimeToolsConfig(enable_agent_formatters=False)
    try:
        diags = [
            {
                'message': 'unexpected indent',
                'line': 2,
                'character': 1,
                'severity': 'error',
                'severity_value': 1,
                'code': '',
                'source': 'Pyright',
                'end_line': 2,
                'end_character': 5,
                'relative_path': 'pkg/x.py',
            }
        ]
        out = post_edit_checks_footer(
            'pkg/x.py',
            diags,
            lsp_scope='workspace',
            server_kind='python',
            formatter_lines=[],
        )
        assert 'Black already ran' not in out
        assert 'formatters disabled' in out.lower()
        assert 'Correct indentation' in out
    finally:
        runtime_config.tools = saved


def test_python_lsp_events_flow_into_clara_logging(lsp_env, tmp_path: Path) -> None:
    log_dir = tmp_path / 'logs'
    reset_logging_handlers()
    configure_logging(log_dir)
    try:
        lsp_env.manager.sync_workspace_document('pkg/mod.py')
        records = get_recent_records(200)
    finally:
        reset_logging_handlers()
    loggers = {record['logger'] for record in records}
    messages = ' '.join(record['message'] for record in records)
    assert 'clara.lsp.manager' in loggers
    assert 'python LSP didOpen' in messages


def test_format_hover_contents_fences_marked_string_with_language() -> None:
    from clara_coder_backend.tools.lsp_tools import _format_hover_contents

    # Legacy MarkedString {language, value} → fenced code block (regression: previously dropped the language).
    out = _format_hover_contents({'language': 'typescript', 'value': 'const x = 1'})
    assert out == '```typescript\nconst x = 1\n```'

    # Legacy MarkedString {language, text} variant also fences.
    out = _format_hover_contents({'language': 'javascript', 'text': 'let y = 2'})
    assert out == '```javascript\nlet y = 2\n```'

    # MarkupContent {kind, value} → value passed through (Monaco renders markdown).
    out = _format_hover_contents({'kind': 'markdown', 'value': '# Title\n\nbody'})
    assert out == '# Title\n\nbody'

    # Plain string stays plain.
    assert _format_hover_contents('  hi  ') == 'hi'

    # List of MarkedStrings joins with blank lines and preserves fences.
    out = _format_hover_contents([{'language': 'typescript', 'value': 'const a = 1'}, 'doc text'])
    assert out == '```typescript\nconst a = 1\n```\n\ndoc text'

    # Empty value with language yields empty (no empty fence).
    assert _format_hover_contents({'language': 'typescript', 'value': ''}) == ''


def test_digest_equal_refresh_after_timed_out_wait_still_did_change(lsp_env, monkeypatch: pytest.MonkeyPatch) -> None:
    """A timed-out wait must not freeze the digest skip; same-text refresh re-sends didChange."""

    import clara_coder_backend.lsp.manager as mgr_mod

    monkeypatch.setattr(mgr_mod, '_DIAG_WAIT_TIMEOUT_S', 0.08)
    monkeypatch.setattr(mgr_mod, '_DIAG_QUIET_S', 0.01)
    shutdown_session_lsp(lsp_env.session_id)
    change_count = {'n': 0}

    class SilentClient(_FakeLspClient):
        def notify(self, method, params):
            if method in ('workspace/didChangeWatchedFiles', 'textDocument/didSave', 'initialized', 'exit'):
                if method == 'exit':
                    self.closed = True
                return
            if method in ('textDocument/didOpen', 'textDocument/didChange'):
                change_count['n'] += 1
                if method == 'textDocument/didOpen':
                    uri = params['textDocument']['uri']
                    text = params['textDocument']['text']
                else:
                    uri = params['textDocument']['uri']
                    text = params['contentChanges'][0]['text']
                self.docs[uri] = text
                return
            if method == 'textDocument/didClose':
                uri = params['textDocument']['uri']
                self.docs.pop(uri, None)
                return
            raise AssertionError(f'unexpected LSP notification: {method}')

    factory = lambda *, command, workspace_root, notification_handler, env=None: SilentClient(
        command=command,
        workspace_root=workspace_root,
        notification_handler=notification_handler,
    )
    manager = get_session_lsp_manager(lsp_env.session_id, client_factory=factory)
    text = 'value = 1\n'
    manager.sync_document('pkg/mod.py', text)
    first = change_count['n']
    assert first >= 1
    manager.sync_document('pkg/mod.py', text)
    assert change_count['n'] > first


def test_parallel_sync_document_same_path_last_content_wins(lsp_env) -> None:
    texts = ['alpha = 1\n', 'beta = 2\n']
    errors: list[BaseException] = []

    def _run(payload: str) -> None:
        try:
            lsp_env.manager.sync_document('pkg/mod.py', payload)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=_run, args=(t,)) for t in texts]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors
    client = lsp_env.manager._client
    assert client is not None
    stored = list(client.docs.values())
    assert len(stored) == 1
    assert stored[0] in texts
    assert lsp_env.manager._doc_versions['pkg/mod.py'] == 2


def test_sync_epoch_advances_across_manager_recreate(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')
    first = lsp_env.manager.get_sync_epoch()
    shutdown_session_lsp(lsp_env.session_id)
    revived = get_session_lsp_manager(lsp_env.session_id, client_factory=lsp_env.factory)
    assert revived.get_sync_epoch() > first


def test_workspace_resync_updates_open_peer_from_disk(lsp_env) -> None:
    (lsp_env.workspace / 'a.py').write_text('a = 1\n', encoding='utf-8')
    (lsp_env.workspace / 'b.py').write_text('b = 1\n', encoding='utf-8')
    manager = get_session_lsp_manager(lsp_env.session_id, client_factory=lsp_env.factory, scope='workspace')
    manager.sync_document('a.py', 'a = 1\n')
    manager.sync_document('b.py', 'b = 1\n')
    (lsp_env.workspace / 'b.py').write_text('b = 99\n', encoding='utf-8')
    manager.resync_tracked_documents_from_disk()
    client = manager._client
    assert client is not None
    peer = [text for uri, text in client.docs.items() if str(uri).replace('\\', '/').endswith('/b.py')]
    assert peer == ['b = 99\n']


def test_hover_keeps_tracked_buffer_until_explicit_disk_sync(lsp_env) -> None:
    manager = get_session_lsp_manager(lsp_env.session_id, client_factory=lsp_env.factory, scope='workspace')
    unsaved = 'value="TODO"\n'
    manager.sync_document('pkg/mod.py', unsaved)
    formatted = 'value = "TODO"\nprint(value)\n'
    (lsp_env.workspace / 'pkg' / 'mod.py').write_text(formatted, encoding='utf-8')
    manager.hover('pkg/mod.py', 1, 1)
    client = manager._client
    assert client is not None
    texts = [text for uri, text in client.docs.items() if str(uri).replace('\\', '/').endswith('/pkg/mod.py')]
    assert texts == [unsaved]
    manager.sync_workspace_document('pkg/mod.py')
    manager.hover('pkg/mod.py', 1, 1)
    texts = [text for uri, text in client.docs.items() if str(uri).replace('\\', '/').endswith('/pkg/mod.py')]
    assert texts == [formatted]
