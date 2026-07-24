"""Tests for the Python LSP manager, tools, and diagnostics routes."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from nemo_backend.app_logging import configure_logging, get_recent_records, reset_logging_handlers
from nemo_backend.domain import EditStagingEntry, RuntimeToolsConfig
from nemo_backend.lsp.manager import (
    activate_session_lsp_scope,
    get_session_lsp_manager,
    shutdown_all_lsp_managers,
    sync_session_document,
)
from nemo_backend.staging_snapshot_session import prepare_new_staging_snapshot_session
from nemo_backend.lsp.file_policy import suggest_edit_tool_for_path
from nemo_backend.tools.lsp_tools import (
    lsp_find_definition,
    lsp_find_references,
    lsp_create_gdscript_file,
    lsp_create_java_file,
    lsp_create_python_file,
    lsp_create_typescript_file,
    lsp_get_diagnostics,
    lsp_get_document_symbols,
    lsp_hover,
    lsp_update_gdscript_file,
    lsp_update_java_file,
    lsp_update_python_file,
    lsp_update_typescript_file,
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


def test_prepare_new_staging_snapshot_session_resets_lsp_and_seeds_snapshot(lsp_env) -> None:
    lsp_env.manager.sync_workspace_document('pkg/mod.py')

    snapshot_id = prepare_new_staging_snapshot_session(lsp_env.session, lsp_env.session_id)

    assert snapshot_id == lsp_env.session.active_staging_snapshot_id
    assert lsp_env.session.lsp_diagnostics == {}
    assert lsp_env.session.lsp_workspace_root == ''
    snapshot_root = Path(lsp_env.session.active_staging_snapshot_root)
    assert snapshot_root.is_dir()
    assert (snapshot_root / 'pkg' / 'mod.py').read_text(encoding='utf-8') == 'value = "TODO"\nprint(value)\n'


def test_typescript_lsp_read_tools(monkeypatch, lsp_env) -> None:
    (lsp_env.workspace / 'app.ts').write_text('const x = 1;\n', encoding='utf-8')

    def _inject(*a, **kwargs):
        kwargs.setdefault('client_factory', lsp_env.factory)
        return get_session_lsp_manager(*a, **kwargs)

    monkeypatch.setattr('nemo_backend.tools.lsp_tools.get_session_lsp_manager', _inject)

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

    monkeypatch.setattr('nemo_backend.tools.lsp_tools.get_session_lsp_manager', lambda *a, **k: _BrokenManager())

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

    monkeypatch.setattr('nemo_backend.lsp.manager.get_session_lsp_manager', _fake_get_session_lsp_manager)
    monkeypatch.setattr('nemo_backend.lsp.manager.shutdown_session_lsp_server', _fake_shutdown_session_lsp_server)
    monkeypatch.setattr(
        'nemo_backend.lsp.manager.shutdown_session_lsp',
        lambda session_id: (_ for _ in ()).throw(AssertionError(f'should not shut down all LSPs: {session_id}')),
    )

    diagnostics = sync_session_document('pkg/mod.py', 'value = 1\n', session_id=lsp_env.session_id)

    assert diagnostics == [{'relative_path': 'pkg/mod.py', 'message': 'ok'}]
    assert shutdown_calls == [(lsp_env.session_id, 'python')]


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

    diag_text = lsp_get_diagnostics.invoke({'relative_path': 'pkg/mod.py', 'refresh_active_document': True})

    assert diag_text.startswith('LSP context: scope=staging; analyzed=overlay_workspace')
    assert 'No LSP diagnostics for `pkg/mod.py`.' in diag_text
    assert 'Staging analysis uses a mirror workspace' in diag_text
    assert staging_manager._client is not None
    assert list(staging_manager._client.docs.values()) == ['value = "done"\nprint(value)\n']


def test_lsp_create_python_file_selects_staging_scope_and_labels_response(monkeypatch, lsp_env) -> None:
    lsp_env.session.auto_apply_mode = False
    captured: dict[str, object] = {}

    def _fake_stage_create(payload: dict[str, object]) -> str:
        captured['payload'] = payload
        return (
            'Staged `pkg/new_mod.py` for code review. The workspace file on disk is **unchanged** until '
            '`transfer_staged_file_to_workspace` succeeds. Python LSP diagnostics: 0 issue(s).'
        )

    monkeypatch.setattr('nemo_backend.tools.lsp_tools.stage_create_file', SimpleNamespace(invoke=_fake_stage_create))

    result = lsp_create_python_file.invoke({'relative_path': 'pkg/new_mod.py', 'new_content': 'value = 1\n'})

    assert result.startswith('Python LSP staging path selected for `pkg/new_mod.py`.')
    assert 'Staged `pkg/new_mod.py` for code review' in result
    assert captured['payload'] == {
        'relative_path': 'pkg/new_mod.py',
        'new_content': 'value = 1\n',
        'encoding': '',
        'newline': '',
        'land_in_workspace': False,
    }
    assert lsp_env.session.lsp_active_scope == 'staging'


def test_lsp_update_python_file_passes_through_tool_errors(monkeypatch, lsp_env) -> None:
    lsp_env.session.auto_apply_mode = False
    monkeypatch.setattr(
        'nemo_backend.tools.lsp_tools.stage_workspace_file_overwrite',
        SimpleNamespace(invoke=lambda payload: f"Tool error: staged overwrite failed for {payload['relative_path']}"),
    )

    result = lsp_update_python_file.invoke({'relative_path': 'pkg/mod.py', 'new_content': 'value = 2\n'})

    assert result == 'Tool error: staged overwrite failed for pkg/mod.py'


def test_lsp_create_typescript_file_selects_staging_scope_and_labels_response(monkeypatch, lsp_env) -> None:
    lsp_env.session.auto_apply_mode = False
    captured: dict[str, object] = {}

    def _fake_stage_create(payload: dict[str, object]) -> str:
        captured['payload'] = payload
        return (
            'Staged `src/app.ts` for code review. The workspace file on disk is **unchanged** until '
            '`transfer_staged_file_to_workspace` succeeds. TypeScript LSP diagnostics: 0 issue(s).'
        )

    monkeypatch.setattr('nemo_backend.tools.lsp_tools.stage_create_file', SimpleNamespace(invoke=_fake_stage_create))

    result = lsp_create_typescript_file.invoke({'relative_path': 'src/app.ts', 'new_content': 'const x = 1;\n'})

    assert result.startswith('TypeScript/JavaScript LSP staging path selected for `src/app.ts`.')
    assert 'Staged `src/app.ts` for code review' in result
    assert captured['payload'] == {
        'relative_path': 'src/app.ts',
        'new_content': 'const x = 1;\n',
        'encoding': '',
        'newline': '',
        'land_in_workspace': False,
    }
    assert lsp_env.session.lsp_active_scope == 'staging'


def test_lsp_update_typescript_file_passes_through_tool_errors(monkeypatch, lsp_env) -> None:
    lsp_env.session.auto_apply_mode = False
    monkeypatch.setattr(
        'nemo_backend.tools.lsp_tools.stage_workspace_file_overwrite',
        SimpleNamespace(invoke=lambda payload: f"Tool error: staged overwrite failed for {payload['relative_path']}"),
    )

    result = lsp_update_typescript_file.invoke({'relative_path': 'src/app.ts', 'new_content': 'const x = 2;\n'})

    assert result == 'Tool error: staged overwrite failed for src/app.ts'


def test_suggest_edit_tool_for_path() -> None:
    assert 'lsp_create_python_file' in suggest_edit_tool_for_path('pkg/mod.py')
    assert 'lsp_create_typescript_file' in suggest_edit_tool_for_path('src/app.ts')
    assert 'stage_create_file' in suggest_edit_tool_for_path('src/app.component.html')
    assert 'stage_create_file' in suggest_edit_tool_for_path('config.json')
    assert 'lsp_create_gdscript_file' in suggest_edit_tool_for_path('game/Main.gd')
    assert 'lsp_create_java_file' in suggest_edit_tool_for_path('src/App.java')


def test_lsp_read_tools_suggest_edit_tool_on_html() -> None:
    html_path = 'src/app.component.html'
    diag = lsp_get_diagnostics.invoke({'relative_path': html_path})
    hover = lsp_hover.invoke({'relative_path': html_path, 'line': 1, 'character': 1})

    for result in (diag, hover):
        assert result.startswith('Tool error:')
        assert 'only support' in result.lower()
        assert 'stage_create_file' in result


def test_typescript_path_guard_rejects_python_extension() -> None:
    result = lsp_create_typescript_file.invoke({'relative_path': 'pkg/mod.py', 'new_content': 'value = 1\n'})

    assert result.startswith('Tool error:')
    assert 'TypeScript/JavaScript LSP mutation tools' in result
    assert 'lsp_create_python_file' in result


def test_lsp_mutation_tools_return_tool_error_for_html() -> None:
    result = lsp_update_typescript_file.invoke(
        {'relative_path': 'src/app.component.html', 'new_content': '<p>hi</p>\n'}
    )

    assert result.startswith('Tool error:')
    assert 'TypeScript/JavaScript LSP mutation tools' in result
    assert 'stage_create_file' in result


def test_lsp_create_python_file_on_html_suggests_staging() -> None:
    result = lsp_create_python_file.invoke(
        {'relative_path': 'src/app.component.html', 'new_content': '<p>hi</p>\n'}
    )

    assert result.startswith('Tool error:')
    assert 'Python LSP mutation tools' in result
    assert 'stage_create_file' in result


def test_lsp_update_python_file_on_ts_suggests_typescript_lsp() -> None:
    result = lsp_update_python_file.invoke({'relative_path': 'src/app.ts', 'new_content': 'const x = 1;\n'})

    assert result.startswith('Tool error:')
    assert 'Python LSP mutation tools' in result
    assert 'lsp_create_typescript_file' in result


def test_lsp_create_gdscript_file_selects_staging_scope_and_labels_response(monkeypatch, lsp_env) -> None:
    lsp_env.session.auto_apply_mode = False
    captured: dict[str, object] = {}

    def _fake_stage_create(payload: dict[str, object]) -> str:
        captured['payload'] = payload
        return (
            'Staged `game/Main.gd` for code review. The workspace file on disk is **unchanged** until '
            '`transfer_staged_file_to_workspace` succeeds. GDScript LSP diagnostics: 0 issue(s).'
        )

    monkeypatch.setattr('nemo_backend.tools.lsp_tools.stage_create_file', SimpleNamespace(invoke=_fake_stage_create))

    result = lsp_create_gdscript_file.invoke({'relative_path': 'game/Main.gd', 'new_content': 'extends Node\n'})

    assert result.startswith('GDScript LSP staging path selected for `game/Main.gd`.')
    assert 'Staged `game/Main.gd` for code review' in result
    assert captured['payload'] == {
        'relative_path': 'game/Main.gd',
        'new_content': 'extends Node\n',
        'encoding': '',
        'newline': '',
        'land_in_workspace': False,
    }
    assert lsp_env.session.lsp_active_scope == 'staging'


def test_lsp_update_gdscript_file_passes_through_tool_errors(monkeypatch, lsp_env) -> None:
    lsp_env.session.auto_apply_mode = False
    monkeypatch.setattr(
        'nemo_backend.tools.lsp_tools.stage_workspace_file_overwrite',
        SimpleNamespace(invoke=lambda payload: f"Tool error: staged overwrite failed for {payload['relative_path']}"),
    )

    result = lsp_update_gdscript_file.invoke({'relative_path': 'game/Main.gd', 'new_content': 'extends Node2D\n'})

    assert result == 'Tool error: staged overwrite failed for game/Main.gd'


def test_gdscript_path_guard_rejects_typescript_extension() -> None:
    result = lsp_create_gdscript_file.invoke({'relative_path': 'src/app.ts', 'new_content': 'const x = 1;\n'})

    assert result.startswith('Tool error:')
    assert 'GDScript LSP mutation tools' in result
    assert 'lsp_create_typescript_file' in result


def test_lsp_create_java_file_selects_staging_scope_and_labels_response(monkeypatch, lsp_env) -> None:
    lsp_env.session.auto_apply_mode = False
    captured: dict[str, object] = {}

    def _fake_stage_create(payload: dict[str, object]) -> str:
        captured['payload'] = payload
        return (
            'Staged `src/App.java` for code review. The workspace file on disk is **unchanged** until '
            '`transfer_staged_file_to_workspace` succeeds. Java LSP diagnostics: 0 issue(s).'
        )

    monkeypatch.setattr('nemo_backend.tools.lsp_tools.stage_create_file', SimpleNamespace(invoke=_fake_stage_create))

    result = lsp_create_java_file.invoke(
        {'relative_path': 'src/App.java', 'new_content': 'public class App {}\n'}
    )

    assert result.startswith('Java LSP staging path selected for `src/App.java`.')
    assert 'Staged `src/App.java` for code review' in result
    assert captured['payload'] == {
        'relative_path': 'src/App.java',
        'new_content': 'public class App {}\n',
        'encoding': '',
        'newline': '',
        'land_in_workspace': False,
    }
    assert lsp_env.session.lsp_active_scope == 'staging'


def test_lsp_update_java_file_passes_through_tool_errors(monkeypatch, lsp_env) -> None:
    lsp_env.session.auto_apply_mode = False
    monkeypatch.setattr(
        'nemo_backend.tools.lsp_tools.stage_workspace_file_overwrite',
        SimpleNamespace(invoke=lambda payload: f"Tool error: staged overwrite failed for {payload['relative_path']}"),
    )

    result = lsp_update_java_file.invoke(
        {'relative_path': 'src/App.java', 'new_content': 'public class App { }\n'}
    )

    assert result == 'Tool error: staged overwrite failed for src/App.java'


def test_java_path_guard_rejects_typescript_extension() -> None:
    result = lsp_create_java_file.invoke({'relative_path': 'src/app.ts', 'new_content': 'const x = 1;\n'})

    assert result.startswith('Tool error:')
    assert 'Java LSP mutation tools' in result
    assert 'lsp_create_typescript_file' in result


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


def test_post_edit_checks_footer_steers_on_indent_diagnostics() -> None:
    from nemo_backend.lsp.diagnostics import post_edit_checks_footer

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
        lsp_scope='staging',
        server_kind='python',
        formatter_lines=['Formatter (Black): applied to the staged draft.'],
    )
    assert 'Steer (indentation-like diagnostics detected)' in out
    assert 'format_staging_file_black' in out
    assert 'refresh_active_document=true' in out


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
    assert 'python LSP didOpen' in messages
