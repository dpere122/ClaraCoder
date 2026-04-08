"""Tests for the Python LSP manager, tools, and diagnostics routes."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from nemo_backend.app_logging import configure_logging, get_recent_records, reset_logging_handlers
from nemo_backend.domain import EditStagingEntry, RuntimeToolsConfig
from nemo_backend.lsp.manager import activate_session_lsp_scope, get_session_lsp_manager, shutdown_all_lsp_managers
from nemo_backend.planner_graph_session import prepare_new_planner_graph_session
from nemo_backend.lsp.tools import (
    lsp_find_definition,
    lsp_find_references,
    lsp_create_python_file,
    lsp_get_diagnostics,
    lsp_get_document_symbols,
    lsp_hover,
    lsp_update_python_file,
)
from nemo_backend.routes_session import clear_session, set_workspace_context
from nemo_backend.routes_lsp import lsp_diagnostics
from nemo_backend.schemas import ClearRequest, WorkspaceContextRequest
from nemo_backend.state import current_session_id, get_session, runtime_config


class _FakeLspClient:
    def __init__(self, *, command, workspace_root, notification_handler):
        self.command = command
        self.workspace_root = workspace_root
        self.notification_handler = notification_handler
        self.docs: dict[str, str] = {}
        self.closed = False
        self.initialized = False

    def initialize(self, *, root_uri, process_id, capabilities):
        del root_uri, process_id, capabilities
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
    session.lsp_diagnostics.clear()
    session.lsp_active_scope = 'workspace'
    session.lsp_workspace_root = ''

    factory = lambda *, command, workspace_root, notification_handler: _FakeLspClient(
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


def test_lsp_scope_switch_shuts_down_staging_manager_before_workspace_review(lsp_env) -> None:
    staging_manager = get_session_lsp_manager(lsp_env.session_id, client_factory=lsp_env.factory, scope='staging')
    staging_manager.sync_document('pkg/mod.py', 'value = "TODO"\n')

    assert lsp_env.session.lsp_active_scope == 'staging'
    assert staging_manager._client is not None
    assert lsp_env.session.lsp_diagnostics

    activate_session_lsp_scope(lsp_env.session_id, scope='workspace')

    assert lsp_env.session.lsp_active_scope == 'workspace'
    assert lsp_env.session.lsp_diagnostics == {}
    assert lsp_env.session.lsp_workspace_root == ''
    assert staging_manager._client is None

    workspace_manager = get_session_lsp_manager(lsp_env.session_id, client_factory=lsp_env.factory)
    assert workspace_manager.scope == 'workspace'
    assert workspace_manager is not staging_manager


def test_prepare_new_planner_graph_session_resets_lsp_and_seeds_snapshot(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')

    graph_id = prepare_new_planner_graph_session(lsp_env.session, lsp_env.session_id)

    assert graph_id == lsp_env.session.active_planner_graph_id
    assert lsp_env.session.lsp_diagnostics == {}
    assert lsp_env.session.lsp_workspace_root == ''
    snapshot_root = Path(lsp_env.session.active_planner_snapshot_root)
    assert snapshot_root.is_dir()
    assert (snapshot_root / 'pkg' / 'mod.py').read_text(encoding='utf-8') == 'value = "TODO"\nprint(value)\n'


def test_lsp_tools_render_expected_outputs(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')

    diag_text = lsp_get_diagnostics.invoke({'relative_path': 'pkg/mod.py'})
    hover_text = lsp_hover.invoke({'relative_path': 'pkg/mod.py', 'line': 1, 'character': 1})
    def_text = lsp_find_definition.invoke({'relative_path': 'pkg/mod.py', 'line': 1, 'character': 1})
    ref_text = lsp_find_references.invoke({'relative_path': 'pkg/mod.py', 'line': 1, 'character': 1})
    sym_text = lsp_get_document_symbols.invoke({'relative_path': 'pkg/mod.py'})

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

    monkeypatch.setattr('nemo_backend.lsp.tools.get_session_lsp_manager', lambda: _BrokenManager())

    result = lsp_get_diagnostics.invoke({'relative_path': 'pkg/mod.py', 'refresh_from_workspace': True})

    assert result.startswith('Tool error: Python LSP diagnostics lookup failed for `pkg/mod.py`')
    assert 'configured language server' in result


def test_lsp_get_diagnostics_refresh_uses_staged_draft_in_staging_scope(lsp_env) -> None:
    lsp_env.session.pending_edit_stagings['pkg/mod.py'] = EditStagingEntry(
        temp_path=str(lsp_env.sample),
        old_text='value = "TODO"\nprint(value)\n',
        merged_text='value = "done"\nprint(value)\n',
        disk_encoding='utf-8',
        disk_newline='lf',
        edit_mode='full-file',
    )
    activate_session_lsp_scope(lsp_env.session_id, scope='staging')
    staging_manager = get_session_lsp_manager(lsp_env.session_id, client_factory=lsp_env.factory, scope='staging')

    diag_text = lsp_get_diagnostics.invoke({'relative_path': 'pkg/mod.py', 'refresh_from_workspace': True})

    assert 'No LSP diagnostics for `pkg/mod.py`.' == diag_text
    assert staging_manager._client is not None
    assert list(staging_manager._client.docs.values()) == ['value = "done"\nprint(value)\n']


def test_lsp_create_python_file_selects_staging_scope_and_labels_response(monkeypatch, lsp_env) -> None:
    captured: dict[str, object] = {}

    def _fake_stage_create(payload: dict[str, object]) -> str:
        captured['payload'] = payload
        return 'Staged `pkg/new_mod.py` for code review (nested planning). Python LSP diagnostics: 0 issue(s).'

    monkeypatch.setattr('nemo_backend.lsp.tools.stage_create_file', SimpleNamespace(invoke=_fake_stage_create))

    result = lsp_create_python_file.invoke({'relative_path': 'pkg/new_mod.py', 'new_content': 'value = 1\n'})

    assert result.startswith('Python LSP staging path selected for `pkg/new_mod.py`.')
    assert 'Staged `pkg/new_mod.py` for code review' in result
    assert captured['payload'] == {
        'relative_path': 'pkg/new_mod.py',
        'new_content': 'value = 1\n',
        'encoding': '',
        'newline': '',
    }
    assert lsp_env.session.lsp_active_scope == 'staging'


def test_lsp_update_python_file_passes_through_tool_errors(monkeypatch, lsp_env) -> None:
    monkeypatch.setattr(
        'nemo_backend.lsp.tools.stage_workspace_file_overwrite',
        SimpleNamespace(invoke=lambda payload: f"Tool error: staged overwrite failed for {payload['relative_path']}"),
    )

    result = lsp_update_python_file.invoke({'relative_path': 'pkg/mod.py', 'new_content': 'value = 2\n'})

    assert result == 'Tool error: staged overwrite failed for pkg/mod.py'


def test_diagnostics_route_returns_cached_python_results(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')
    payload = asyncio.run(lsp_diagnostics(session_id=lsp_env.session_id, relative_path='pkg/mod.py'))
    assert payload['relativePath'] == 'pkg/mod.py'
    diagnostics = payload['diagnostics']
    assert isinstance(diagnostics, list)
    assert diagnostics[0]['source'] == 'fake-lsp'


def test_workspace_context_change_clears_lsp_session(lsp_env, tmp_path: Path) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')
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
    assert lsp_env.session.lsp_diagnostics == {}
    assert lsp_env.session.lsp_workspace_root == ''


def test_clear_session_shuts_down_lsp_state(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')
    asyncio.run(clear_session(ClearRequest(session_id=lsp_env.session_id)))
    session = get_session(lsp_env.session_id)
    assert session.lsp_diagnostics == {}
    assert session.workspace_path == ''


def test_python_lsp_events_flow_into_nemo_logging(lsp_env, tmp_path: Path) -> None:
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
    assert 'nemo.lsp.manager' in loggers
    assert 'python diagnostics refreshed' in messages
