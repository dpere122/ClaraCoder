"""GDScript plugin, project root search, capability gating and progress, without a real server."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from clara_coder_backend.lsp.editor_features import run_editor_feature, workspace_symbols
from clara_coder_backend.lsp.editor_monaco import serialize_locations_payload
from clara_coder_backend.lsp.godot_project_root import resolve_godot_project_root
from clara_coder_backend.lsp.manager import (
    SessionWorkspaceLspManager,
    _deep_merge,
    _workspace_capabilities,
    shutdown_all_lsp_managers,
)
from clara_coder_backend.lsp.plugins.gdscript_plugin import GdscriptLspPlugin, GdscriptPluginState
from clara_coder_backend.lsp.server_plugin import LspServerNotInstalledError
from clara_coder_backend.runtime.deps.providers import gdls
from clara_coder_backend.session.state import current_session_id, get_session


def _project(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / 'project.godot').write_text('config_version=5\n', encoding='utf-8')
    return path


def test_root_is_the_nearest_project_above_the_file(tmp_path: Path) -> None:
    game = _project(tmp_path / 'games' / 'one')
    _project(tmp_path / 'games' / 'two')
    assert resolve_godot_project_root(tmp_path, 'games/one/scripts/a.gd') == game.resolve()


def test_root_is_found_for_a_file_outside_any_project(tmp_path: Path) -> None:
    game = _project(tmp_path / 'client')
    assert resolve_godot_project_root(tmp_path, 'tools/a.gd') == game.resolve()


def test_root_search_prefers_the_shallowest_and_skips_addons_and_dot_dirs(tmp_path: Path) -> None:
    _project(tmp_path / 'addons' / 'demo')
    _project(tmp_path / '.cache' / 'copy')
    _project(tmp_path / 'a' / 'b' / 'deep')
    shallow = _project(tmp_path / 'z')
    assert resolve_godot_project_root(tmp_path) == shallow.resolve()


def test_root_falls_back_to_the_workspace(tmp_path: Path) -> None:
    (tmp_path / 'scripts').mkdir()
    assert resolve_godot_project_root(tmp_path, 'scripts/a.gd') == tmp_path.resolve()


def test_workspace_root_project_wins(tmp_path: Path) -> None:
    _project(tmp_path)
    _project(tmp_path / 'sub')
    assert resolve_godot_project_root(tmp_path, 'scripts/a.gd') == tmp_path.resolve()


def _session() -> Any:
    return SimpleNamespace(lsp=SimpleNamespace())


def test_plugin_requires_the_dependency(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_GDSCRIPT_LSP_COMMAND', raising=False)
    monkeypatch.setattr(gdls, 'installed_binary', lambda: None)
    plugin = GdscriptLspPlugin()
    with pytest.raises(LspServerNotInstalledError, match='Dependencies'):
        plugin.compute_start_params(session=_session(), workspace_root=tmp_path, state=plugin.create_state())


def test_plugin_runs_the_installed_binary_with_init_options(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    game = _project(tmp_path / 'game')
    binary = tmp_path / 'gdls.exe'
    monkeypatch.delenv('CLARA_GDSCRIPT_LSP_COMMAND', raising=False)
    monkeypatch.delenv('CLARA_GDSCRIPT_FORMATTER_COMMAND', raising=False)
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(tmp_path / 'runtime'))
    monkeypatch.setenv('CLARA_GODOT_BINARY', 'C:/godot/godot.exe')
    monkeypatch.setattr(gdls, 'installed_binary', lambda: binary)
    monkeypatch.setattr('shutil.which', lambda name: None)

    plugin = GdscriptLspPlugin()
    state = GdscriptPluginState(last_seed='game/scripts/a.gd')
    params = plugin.compute_start_params(session=_session(), workspace_root=tmp_path, state=state)

    assert params.command == [str(binary)]
    assert params.lsp_cwd == game.resolve()
    assert params.init_options['projectRoot'] == str(game.resolve())
    assert params.init_options['stubCacheDir'] == str((tmp_path / 'runtime' / 'gdls').resolve())
    assert params.init_options['godotBinaryPath'] == 'C:/godot/godot.exe'
    assert 'formatter' not in params.init_options


def test_formatter_comes_from_path_or_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_GDSCRIPT_LSP_COMMAND', 'custom-server')
    monkeypatch.delenv('CLARA_GDSCRIPT_FORMATTER_COMMAND', raising=False)
    monkeypatch.setattr('shutil.which', lambda name: f'/usr/bin/{name}')
    plugin = GdscriptLspPlugin()
    params = plugin.compute_start_params(session=_session(), workspace_root=tmp_path, state=plugin.create_state())
    assert params.command == ['custom-server']
    assert params.init_options['formatter'] == {'command': '/usr/bin/gdformat', 'args': ['-']}

    monkeypatch.setenv('CLARA_GDSCRIPT_FORMATTER_COMMAND', 'gdscript-formatter --stdin')
    params = plugin.compute_start_params(session=_session(), workspace_root=tmp_path, state=plugin.create_state())
    assert params.init_options['formatter'] == {'command': 'gdscript-formatter', 'args': ['--stdin']}


def test_plugin_restarts_when_the_project_changes(tmp_path: Path) -> None:
    _project(tmp_path / 'one')
    _project(tmp_path / 'two')
    plugin = GdscriptLspPlugin()
    state = plugin.create_state()

    def sync(rel: str, *, running: bool = True) -> bool:
        return plugin.on_before_sync_document(
            session=_session(), workspace_root=tmp_path, relative_posix_path=rel, state=state, client_running=running
        )

    assert sync('one/a.gd', running=False) is False
    assert sync('one/b.gd') is False
    assert sync('two/c.gd') is True
    assert state.project_root == (tmp_path / 'two').resolve()
    assert sync('two/d.gd') is False


def test_capability_overrides_reach_only_this_server() -> None:
    shared = _workspace_capabilities()
    merged = _deep_merge(shared, GdscriptLspPlugin().client_capability_overrides())
    text = merged['textDocument']
    assert text['rename'] == {'dynamicRegistration': False, 'prepareSupport': True}
    assert text['semanticTokens']['requests'] == {'range': True, 'full': {'delta': True}}
    assert text['semanticTokens']['formats'] == ['relative'], 'the merge keeps sibling keys'
    assert text['completion']['completionItem']['snippetSupport'] is True
    assert merged['window']['workDoneProgress'] is True
    assert merged['workspace']['fileOperations'] == {'willRename': True, 'didRename': True}
    # Each of these would switch gdls to a path our client doesn't implement.
    assert 'resolveSupport' not in text['codeAction']
    assert 'workspaceEdit' not in merged['workspace']
    assert 'diagnostic' not in text
    assert 'general' not in merged
    # The dict the other servers receive is untouched.
    assert shared['textDocument']['rename']['prepareSupport'] is False
    assert 'window' not in shared


class _FakeClient:
    """Records requests and answers from a table; advertises only ``capabilities``."""

    def __init__(self, capabilities: dict[str, Any], results: dict[str, Any] | None = None) -> None:
        self.capabilities = capabilities
        self.results = results or {}
        self.requests: list[str] = []
        self.notifications: list[tuple[str, dict[str, Any]]] = []
        self.initialize_capabilities: dict[str, Any] = {}

    def initialize(self, *, root_uri, process_id, capabilities, initialization_options=None):  # noqa: ANN001, ANN202
        del root_uri, process_id, initialization_options
        self.initialize_capabilities = capabilities
        return {'capabilities': self.capabilities}

    def request(self, method: str, params: dict[str, Any], *, timeout_s: float = 10.0) -> Any:
        del params, timeout_s
        self.requests.append(method)
        return self.results.get(method)

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.notifications.append((method, params))

    def is_running(self) -> bool:
        return True

    def shutdown(self) -> None:
        return None

    def close(self) -> None:
        return None


@pytest.fixture
def manager_for(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    monkeypatch.setenv('CLARA_GDSCRIPT_LSP_COMMAND', 'fake-gdls')
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(tmp_path / 'runtime'))
    session_id = 'gdscript-plugin-tests'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(tmp_path.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    (tmp_path / 'a.gd').write_text('extends Node\n', encoding='utf-8')
    managers: list[SessionWorkspaceLspManager] = []

    def build(client: _FakeClient) -> SessionWorkspaceLspManager:
        manager = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=tmp_path,
            scope='workspace',
            server_kind='gdscript',
            client_factory=lambda **kwargs: client,
        )
        managers.append(manager)
        return manager

    yield build
    for manager in managers:
        manager.shutdown()
    current_session_id.reset(token)
    shutdown_all_lsp_managers()


def test_unserved_methods_are_not_sent(manager_for) -> None:  # noqa: ANN001
    client = _FakeClient({})
    manager = manager_for(client)
    assert manager.formatting('a.gd') == []
    assert manager.range_formatting('a.gd', 1, 1, 1, 1) == []
    assert manager.on_type_formatting('a.gd', 1, 1, '\n') == []
    assert run_editor_feature(manager, 'a.gd', 'implementation', {'line': 1, 'character': 1}) == {'locations': []}
    assert run_editor_feature(manager, 'a.gd', 'foldingRanges', {}) == {'ranges': []}
    assert run_editor_feature(manager, 'a.gd', 'callHierarchy', {'line': 1, 'character': 1}) == {'locations': []}
    assert workspace_symbols(manager, 'x') == []
    assert client.requests == []
    assert manager.will_rename_files([('a.gd', 'b.gd')]) is None
    manager.did_rename_files([('a.gd', 'b.gd')])
    assert not [n for n in client.notifications if n[0] == 'workspace/didRenameFiles']


def test_unknown_feature_is_rejected(manager_for) -> None:  # noqa: ANN001
    manager = manager_for(_FakeClient({}))
    with pytest.raises(ValueError, match='Unknown LSP editor feature'):
        run_editor_feature(manager, 'a.gd', 'shutdown', {})


def test_capabilities_sent_at_initialize_include_the_overrides(manager_for) -> None:  # noqa: ANN001
    client = _FakeClient({})
    manager_for(client).ensure_started()
    assert client.initialize_capabilities['window']['workDoneProgress'] is True


def test_not_installed_message_reaches_the_dashboard(tmp_path, monkeypatch, manager_for) -> None:  # noqa: ANN001
    monkeypatch.delenv('CLARA_GDSCRIPT_LSP_COMMAND', raising=False)
    monkeypatch.setattr(gdls, 'installed_binary', lambda: None)
    manager = manager_for(_FakeClient({}))
    with pytest.raises(LspServerNotInstalledError):
        manager.ensure_started()
    entry = manager.dashboard_entry()
    assert entry['phase'] == 'crashed'
    assert 'Dependencies' in entry['lastError']


def test_progress_shows_as_indexing_until_every_token_ends(manager_for) -> None:  # noqa: ANN001
    manager = manager_for(_FakeClient({}))
    manager.ensure_started()
    assert manager.lifecycle_phase() == 'running'

    def progress(token: str, kind: str, title: str = '') -> None:
        manager._handle_notification('$/progress', {'token': token, 'value': {'kind': kind, 'title': title}})

    progress('a', 'begin', 'Indexing project')
    progress('b', 'begin', 'Reconciling')
    assert manager.lifecycle_phase() == 'indexing'
    assert 'Indexing project' in manager.dashboard_entry()['languageStatus']
    progress('a', 'report')
    progress('a', 'end')
    assert manager.lifecycle_phase() == 'indexing'
    progress('b', 'end')
    assert manager.lifecycle_phase() == 'running'
    assert 'languageStatus' not in manager.dashboard_entry()


def test_external_path_only_for_the_servers_own_pages(tmp_path: Path, manager_for) -> None:  # noqa: ANN001
    manager = manager_for(_FakeClient({}))
    stub = tmp_path / 'runtime' / 'gdls' / 'stubs' / 'Node2D.gd'
    stub.parent.mkdir(parents=True)
    stub.write_text('class Node2D\n', encoding='utf-8')
    elsewhere = tmp_path.parent / 'not-a-stub.gd'
    rng = {'start': {'line': 2, 'character': 0}, 'end': {'line': 2, 'character': 4}}

    rows = serialize_locations_payload(
        manager,
        [
            {'uri': stub.as_uri(), 'range': rng},
            {'uri': elsewhere.as_uri(), 'range': rng},
            {'uri': (tmp_path / 'a.gd').as_uri(), 'range': rng},
        ],
    )

    assert rows[0]['externalPath'] == stub.resolve().as_posix()
    assert rows[0]['range']['startLineNumber'] == 3
    assert 'externalPath' not in rows[1]
    assert rows[2] == {'relativePath': 'a.gd', 'range': rows[2]['range']}


def test_hierarchy_flattens_one_level(tmp_path: Path, manager_for) -> None:  # noqa: ANN001
    uri = (tmp_path / 'a.gd').as_uri()
    rng = {'start': {'line': 4, 'character': 1}, 'end': {'line': 4, 'character': 5}}
    call_site = {'start': {'line': 9, 'character': 2}, 'end': {'line': 9, 'character': 6}}
    item = {'name': 'caller', 'kind': 12, 'uri': uri, 'range': rng, 'selectionRange': rng}
    client = _FakeClient(
        {'callHierarchyProvider': True},
        {
            'textDocument/prepareCallHierarchy': [item],
            'callHierarchy/incomingCalls': [{'from': item, 'fromRanges': [call_site]}],
            'callHierarchy/outgoingCalls': [{'to': item, 'fromRanges': [call_site]}],
        },
    )
    manager = manager_for(client)

    incoming = run_editor_feature(manager, 'a.gd', 'callHierarchy', {'line': 1, 'character': 1})['locations']
    assert incoming[0]['name'] == 'caller'
    assert incoming[0]['range']['startLineNumber'] == 10, 'a caller points at the call site'

    outgoing = run_editor_feature(
        manager, 'a.gd', 'callHierarchy', {'line': 1, 'character': 1, 'direction': 'outgoing'}
    )['locations']
    assert outgoing[0]['range']['startLineNumber'] == 5, 'a callee points at its declaration'
    assert 'callHierarchy/outgoingCalls' in client.requests


def test_prepare_rename_shapes(tmp_path: Path, manager_for) -> None:  # noqa: ANN001
    rng = {'start': {'line': 0, 'character': 1}, 'end': {'line': 0, 'character': 4}}
    results: dict[str, Any] = {'textDocument/prepareRename': {'range': rng, 'placeholder': 'foo'}}
    manager = manager_for(_FakeClient({'renameProvider': {'prepareProvider': True}}, results))
    params = {'line': 1, 'character': 2}
    assert run_editor_feature(manager, 'a.gd', 'prepareRename', params)['placeholder'] == 'foo'
    results['textDocument/prepareRename'] = rng
    bare = run_editor_feature(manager, 'a.gd', 'prepareRename', params)
    assert bare['range']['startColumn'] == 2
    assert bare['placeholder'] is None
    results['textDocument/prepareRename'] = None
    assert run_editor_feature(manager, 'a.gd', 'prepareRename', params)['range'] is None


def test_selection_ranges_flatten_parent_chain(manager_for) -> None:  # noqa: ANN001
    inner = {'start': {'line': 0, 'character': 1}, 'end': {'line': 0, 'character': 2}}
    outer = {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 9}}
    manager = manager_for(
        _FakeClient(
            {'selectionRangeProvider': True},
            {'textDocument/selectionRange': [{'range': inner, 'parent': {'range': outer}}]},
        )
    )
    chains = run_editor_feature(manager, 'a.gd', 'selectionRanges', {'positions': [{'lineNumber': 1, 'column': 2}]})
    assert [r['startColumn'] for r in chains['selections'][0]] == [2, 1]


def test_folding_lines_become_one_based(manager_for) -> None:  # noqa: ANN001
    manager = manager_for(
        _FakeClient(
            {'foldingRangeProvider': True},
            {'textDocument/foldingRange': [{'startLine': 0, 'endLine': 3, 'kind': 'region'}]},
        )
    )
    assert run_editor_feature(manager, 'a.gd', 'foldingRanges', {}) == {'ranges': [{'start': 1, 'end': 4, 'kind': 'region'}]}


def test_document_links_split_workspace_files_and_urls(tmp_path: Path, manager_for) -> None:  # noqa: ANN001
    rng = {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 1}}
    manager = manager_for(
        _FakeClient(
            {'documentLinkProvider': {}},
            {
                'textDocument/documentLink': [
                    {'range': rng, 'target': (tmp_path / 'a.gd').as_uri(), 'tooltip': 'open'},
                    {'range': rng, 'target': 'https://godotengine.org'},
                    {'range': rng},
                ]
            },
        )
    )
    links = run_editor_feature(manager, 'a.gd', 'documentLinks', {})['links']
    assert links[0]['relativePath'] == 'a.gd'
    assert links[0]['tooltip'] == 'open'
    assert links[1]['url'] == 'https://godotengine.org'
    assert len(links) == 2
