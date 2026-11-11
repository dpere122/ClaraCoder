"""Rust plugin: workspace trust, project lookup, settings and server health, without a real server."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from clara_coder_backend.domain import RuntimeRustLspConfig
from clara_coder_backend.lsp import manager as lsp_manager_module
from clara_coder_backend.lsp.file_policy import lsp_server_for_path, requires_code_review
from clara_coder_backend.lsp.manager import (
    DOC_ORIGIN_EDITOR,
    SessionWorkspaceLspManager,
    shutdown_all_lsp_managers,
)
from clara_coder_backend.lsp.plugins import rust_plugin
from clara_coder_backend.lsp.plugins.rust_plugin import RustLspPlugin, RustPluginState, build_rust_init_options
from clara_coder_backend.lsp.registry import workspace_trust_lsp_server_ids
from clara_coder_backend.lsp.rust_project_root import find_rust_project
from clara_coder_backend.lsp.server_plugin import LspServerNotInstalledError
from clara_coder_backend.runtime.deps.providers import rust_analyzer
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config, runtime_config_received
from clara_coder_backend.workspace.trust import trusted_workspace_keys, workspace_is_trusted, workspace_trust_key


def _crate(path: Path, manifest: str = '[package]\nname = "x"\nversion = "0.1.0"\n') -> Path:
    (path / 'src').mkdir(parents=True, exist_ok=True)
    (path / 'Cargo.toml').write_text(manifest, encoding='utf-8')
    (path / 'src' / 'lib.rs').write_text('pub fn f() {}\n', encoding='utf-8')
    return path / 'Cargo.toml'


def _trust(monkeypatch: pytest.MonkeyPatch, *workspaces: Path) -> None:
    monkeypatch.setattr(runtime_config, 'trusted_workspace_keys', trusted_workspace_keys(str(w) for w in workspaces))


# --- workspace trust


def test_nothing_is_trusted_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_config, 'trusted_workspace_keys', frozenset())
    assert workspace_is_trusted(tmp_path) is False
    assert workspace_is_trusted('') is False


def test_trust_is_for_that_folder_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / 'inner').mkdir()
    _trust(monkeypatch, tmp_path)
    assert workspace_is_trusted(tmp_path) is True
    assert workspace_is_trusted(str(tmp_path) + '/') is True, 'the same folder spelled another way'
    assert workspace_is_trusted(tmp_path / 'inner') is False
    assert workspace_is_trusted(tmp_path.parent) is False


def test_trust_keys_drop_blank_paths() -> None:
    assert trusted_workspace_keys(['', '   ']) == frozenset()
    assert workspace_trust_key('  ') == ''


def test_servers_that_follow_workspace_trust() -> None:
    assert set(workspace_trust_lsp_server_ids()) == {'rust', 'gdscript'}


# --- file policy


def test_rust_files_go_to_the_rust_server() -> None:
    assert lsp_server_for_path('src/main.rs') == 'rust'
    assert requires_code_review('src/main.rs') is True
    assert lsp_server_for_path('Cargo.toml') is None


# --- project lookup


def test_project_is_the_nearest_manifest(tmp_path: Path) -> None:
    manifest = _crate(tmp_path / 'tools' / 'cli')
    assert find_rust_project(tmp_path, 'tools/cli/src/bin/a.rs') == manifest.resolve()


def test_members_share_the_cargo_workspace_manifest(tmp_path: Path) -> None:
    root = _crate(tmp_path, '[workspace]\nmembers = ["crates/*"]\n')
    _crate(tmp_path / 'crates' / 'a')
    _crate(tmp_path / 'crates' / 'b')
    assert find_rust_project(tmp_path, 'crates/a/src/lib.rs') == root.resolve()
    assert find_rust_project(tmp_path, 'crates/b/src/lib.rs') == root.resolve()


def test_a_crate_the_workspace_excludes_is_its_own_project(tmp_path: Path) -> None:
    _crate(tmp_path, '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/fuzz"]\n')
    fuzz = _crate(tmp_path / 'crates' / 'fuzz')
    assert find_rust_project(tmp_path, 'crates/fuzz/src/lib.rs') == fuzz.resolve()


def test_a_nested_cargo_workspace_is_found_from_inside_it(tmp_path: Path) -> None:
    inner = _crate(tmp_path / 'backend', '[workspace]\nmembers = ["api"]\n')
    _crate(tmp_path / 'backend' / 'api')
    assert find_rust_project(tmp_path, 'backend/api/src/lib.rs') == inner.resolve()


def test_the_search_stops_at_the_clara_workspace(tmp_path: Path) -> None:
    _crate(tmp_path, '[workspace]\nmembers = ["ws/member"]\n')
    member = _crate(tmp_path / 'ws' / 'member')
    assert find_rust_project(tmp_path / 'ws', 'member/src/lib.rs') == member.resolve()


def test_an_unreadable_manifest_still_counts_as_a_crate(tmp_path: Path) -> None:
    manifest = _crate(tmp_path, 'this is [not toml\n')
    assert find_rust_project(tmp_path, 'src/lib.rs') == manifest.resolve()


def test_rust_project_json_nearer_than_a_manifest_wins(tmp_path: Path) -> None:
    _crate(tmp_path)
    (tmp_path / 'gen').mkdir()
    project_json = tmp_path / 'gen' / 'rust-project.json'
    project_json.write_text('{"crates": []}', encoding='utf-8')
    (tmp_path / 'gen' / 'a.rs').write_text('', encoding='utf-8')
    assert find_rust_project(tmp_path, 'gen/a.rs') == project_json.resolve()
    assert find_rust_project(tmp_path, 'src/lib.rs') == (tmp_path / 'Cargo.toml').resolve()


def test_a_file_with_no_manifest_is_a_standalone_project(tmp_path: Path) -> None:
    (tmp_path / 'scratch').mkdir()
    (tmp_path / 'scratch' / 'a.rs').write_text('fn main() {}\n', encoding='utf-8')
    assert find_rust_project(tmp_path, 'scratch/a.rs') == (tmp_path / 'scratch' / 'a.rs').resolve()


def test_a_path_outside_the_workspace_has_no_project(tmp_path: Path) -> None:
    assert find_rust_project(tmp_path / 'ws', '../other/a.rs') is None


# --- plugin


def _session() -> Any:
    return SimpleNamespace(lsp=SimpleNamespace())


@pytest.fixture
def rust_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> RuntimeRustLspConfig:
    settings = RuntimeRustLspConfig()
    monkeypatch.setattr(runtime_config.lsp, 'rust', settings)
    monkeypatch.setenv('CLARA_RUST_LSP_COMMAND', 'custom-rust-analyzer')
    monkeypatch.setattr(rust_plugin, 'find_cargo', lambda: Path('/toolchain/bin/cargo'))
    monkeypatch.setattr(rust_plugin.shutil, 'which', lambda name: '/toolchain/bin/cargo')
    _trust(monkeypatch, tmp_path)
    return settings


def _start(workspace: Path, state: RustPluginState | None = None, *, scope: str = 'workspace'):  # noqa: ANN202
    plugin = RustLspPlugin()
    return plugin.compute_start_params(
        session=_session(), workspace_root=workspace, state=state or plugin.create_state(), scope=scope
    )


def test_an_untrusted_workspace_does_not_start_the_server(tmp_path: Path, rust_settings, monkeypatch) -> None:  # noqa: ANN001
    _trust(monkeypatch, tmp_path / 'somewhere-else')
    _crate(tmp_path)
    with pytest.raises(LspServerNotInstalledError, match='trusted workspace') as raised:
        _start(tmp_path, RustPluginState(last_seed='src/lib.rs'))
    assert 'Settings → Workspaces' in str(raised.value)


def test_the_command_override_does_not_get_around_trust(tmp_path: Path, rust_settings, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(runtime_config, 'trusted_workspace_keys', frozenset())
    with pytest.raises(LspServerNotInstalledError, match='trusted workspace'):
        _start(tmp_path)


def test_plugin_requires_the_dependency(tmp_path: Path, rust_settings, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.delenv('CLARA_RUST_LSP_COMMAND', raising=False)
    monkeypatch.setattr(rust_analyzer, 'installed_binary', lambda: None)
    with pytest.raises(LspServerNotInstalledError, match='Dependencies'):
        _start(tmp_path)


def test_plugin_requires_cargo(tmp_path: Path, rust_settings, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(rust_plugin, 'find_cargo', lambda: None)
    with pytest.raises(LspServerNotInstalledError, match='rustup.rs'):
        _start(tmp_path)


def test_plugin_runs_the_installed_binary_on_the_seed_files_project(tmp_path: Path, rust_settings, monkeypatch) -> None:  # noqa: ANN001
    manifest = _crate(tmp_path / 'app')
    binary = tmp_path / 'rust-analyzer.exe'
    monkeypatch.delenv('CLARA_RUST_LSP_COMMAND', raising=False)
    monkeypatch.setattr(rust_analyzer, 'installed_binary', lambda: binary)

    params = _start(tmp_path, RustPluginState(last_seed='app/src/lib.rs'))

    assert params.command == [str(binary)]
    assert params.lsp_cwd == tmp_path.resolve(), 'the root stays put so a second crate needs no restart'
    assert params.init_options['linkedProjects'] == [str(manifest.resolve())]
    assert params.env is None, 'cargo is already on PATH'


def test_cargo_outside_path_is_put_on_the_servers_path(tmp_path: Path, rust_settings, monkeypatch) -> None:  # noqa: ANN001
    cargo = tmp_path / 'home' / '.cargo' / 'bin' / 'cargo'
    monkeypatch.setattr(rust_plugin, 'find_cargo', lambda: cargo)
    monkeypatch.setattr(rust_plugin.shutil, 'which', lambda name: None)
    params = _start(tmp_path)
    assert params.env is not None
    assert params.env['PATH'].split(rust_plugin.os.pathsep)[0] == str(cargo.parent)


def test_defaults_turn_on_the_features_that_run_project_code(tmp_path: Path, rust_settings) -> None:  # noqa: ANN001
    options = _start(tmp_path).init_options
    assert options['cargo']['buildScripts'] == {'enable': True}
    assert options['procMacro'] == {'enable': True}
    assert options['checkOnSave'] is True
    assert options['check'] == {'command': 'check'}
    assert options['cargo']['targetDir'] is True
    assert options['cargo']['features'] == []
    assert options['files'] == {'watcher': 'server'}


def test_settings_reach_rust_analyzer(tmp_path: Path, rust_settings) -> None:  # noqa: ANN001
    rust_settings.run_build_scripts = False
    rust_settings.expand_proc_macros = False
    rust_settings.check_on_save = False
    rust_settings.check_command = 'clippy'
    rust_settings.separate_target_dir = False
    rust_settings.all_features = True
    rust_settings.inlay_parameter_hints = False
    options = _start(tmp_path).init_options
    assert options['cargo'] == {'buildScripts': {'enable': False}, 'features': 'all', 'targetDir': None}
    assert options['procMacro'] == {'enable': False}
    assert options['checkOnSave'] is False
    assert options['check'] == {'command': 'clippy'}
    assert options['inlayHints'] == {
        'typeHints': {'enable': True},
        'parameterHints': {'enable': False},
        'chainingHints': {'enable': True},
    }


def test_the_staging_server_does_not_run_cargo_check(tmp_path: Path, rust_settings) -> None:  # noqa: ANN001
    assert _start(tmp_path, scope='staging').init_options['checkOnSave'] is False


def test_a_second_project_is_linked_without_a_restart(tmp_path: Path, rust_settings) -> None:  # noqa: ANN001
    first = _crate(tmp_path / 'one')
    second = _crate(tmp_path / 'two')
    plugin = RustLspPlugin()
    state = plugin.create_state()

    def sync(rel: str, *, running: bool) -> bool:
        return plugin.on_before_sync_document(
            session=_session(), workspace_root=tmp_path, relative_posix_path=rel, state=state, client_running=running
        )

    assert sync('one/src/lib.rs', running=False) is False
    assert plugin.take_pending_initialization_options(state) is None, 'the start itself carries the first project'
    plugin.compute_start_params(session=_session(), workspace_root=tmp_path, state=state)

    assert sync('one/src/lib.rs', running=True) is False
    assert plugin.take_pending_initialization_options(state) is None, 'a file of a linked project changes nothing'

    assert sync('two/src/lib.rs', running=True) is False
    pending = plugin.take_pending_initialization_options(state)
    assert pending is not None
    assert pending['linkedProjects'] == [str(first.resolve()), str(second.resolve())]
    assert plugin.take_pending_initialization_options(state) is None, 'consumed once'


def test_a_restart_keeps_the_linked_projects_and_drops_deleted_ones(tmp_path: Path, rust_settings) -> None:  # noqa: ANN001
    kept = _crate(tmp_path / 'kept')
    gone = _crate(tmp_path / 'gone')
    state = RustPluginState(last_seed='kept/src/lib.rs', linked_projects=[gone.resolve(), kept.resolve()])
    gone.unlink()
    assert _start(tmp_path, state).init_options['linkedProjects'] == [str(kept.resolve())]


def test_no_server_starts_for_the_legend_alone(rust_settings) -> None:  # noqa: ANN001
    plugin = RustLspPlugin()
    assert plugin.should_defer_semantic_tokens_legend_without_document_seed(plugin.create_state()) is True
    assert plugin.should_defer_semantic_tokens_legend_without_document_seed(RustPluginState(last_seed='a.rs')) is False


def test_the_start_waits_for_the_trust_list(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rust_plugin, '_RUNTIME_CONFIG_WAIT_S', 0.01)
    was_set = runtime_config_received.is_set()
    runtime_config_received.clear()
    try:
        with pytest.raises(LspServerNotInstalledError, match="haven't reached"):
            RustLspPlugin().wait_until_ready_to_start()
        runtime_config_received.set()
        RustLspPlugin().wait_until_ready_to_start()
    finally:
        if was_set:
            runtime_config_received.set()
        else:
            runtime_config_received.clear()


def test_server_health_comes_from_the_status_notification() -> None:
    plugin = RustLspPlugin()
    status = 'experimental/serverStatus'
    assert plugin.server_health_from_notification('window/logMessage', {'message': 'x'}) is None
    assert plugin.server_health_from_notification(status, {'health': 'ok', 'quiescent': True}) == ''
    assert plugin.server_health_from_notification(status, {'health': 'ok', 'message': 'not a problem'}) == ''
    warning = {'health': 'warning', 'quiescent': True, 'message': 'Failed to load\n  the sysroot.\n\nInstall rust-src.'}
    assert plugin.server_health_from_notification(status, warning) == 'Failed to load the sysroot. Install rust-src.'
    long = plugin.server_health_from_notification(status, {'health': 'error', 'message': 'x' * 1000})
    assert long is not None and len(long) == 300 and long.endswith('…')


def test_init_options_are_the_rust_analyzer_section() -> None:
    options = build_rust_init_options(RuntimeRustLspConfig(), [Path('/ws/Cargo.toml')], scope='workspace')
    assert 'rust-analyzer' not in options and 'settings' not in options
    assert options['linkedProjects'] == [str(Path('/ws/Cargo.toml'))]


# --- through the manager


class _FakeClient:
    def __init__(self) -> None:
        self.initialize_kwargs: dict[str, Any] = {}
        self.notifications: list[tuple[str, dict[str, Any]]] = []
        self.configurations: list[dict[str, Any]] = []

    def initialize(self, **kwargs: Any) -> dict[str, Any]:
        self.initialize_kwargs = kwargs
        return {'capabilities': {}}

    def update_configuration(self, options: dict[str, Any]) -> None:
        self.configurations.append(options)

    def request(self, method: str, params: dict[str, Any], *, timeout_s: float = 10.0) -> Any:
        return None

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.notifications.append((method, params))

    def is_running(self) -> bool:
        return True

    def shutdown(self) -> None:
        return None

    def close(self) -> None:
        return None


@pytest.fixture
def manager_for(tmp_path: Path, rust_settings, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN001, ANN201
    session_id = 'rust-plugin-tests'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = str(tmp_path.resolve())
    session.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
    was_set = runtime_config_received.is_set()
    runtime_config_received.set()
    managers: list[SessionWorkspaceLspManager] = []

    def build(client: _FakeClient) -> SessionWorkspaceLspManager:
        manager = SessionWorkspaceLspManager(
            session_id=session_id,
            session=session,
            workspace_root=tmp_path,
            scope='workspace',
            server_kind='rust',
            client_factory=lambda **kwargs: client,
        )
        managers.append(manager)
        return manager

    yield build
    for manager in managers:
        manager.shutdown()
    if not was_set:
        runtime_config_received.clear()
    current_session_id.reset(token)
    shutdown_all_lsp_managers()


def test_manager_starts_rust_analyzer_with_its_settings_section(manager_for, tmp_path: Path) -> None:  # noqa: ANN001
    manifest = _crate(tmp_path)
    client = _FakeClient()
    manager = manager_for(client)

    manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=False)

    assert client.initialize_kwargs['configuration_section'] == 'rust-analyzer'
    assert client.initialize_kwargs['initialization_options']['linkedProjects'] == [str(manifest.resolve())]
    capabilities = client.initialize_kwargs['capabilities']
    assert capabilities['experimental'] == {'serverStatusNotification': True}
    assert capabilities['window'] == {'workDoneProgress': True}
    assert [method for method, _ in client.notifications] == ['textDocument/didOpen', 'textDocument/didSave']


def test_text_already_on_disk_is_reported_as_saved_so_cargo_check_runs(manager_for, tmp_path: Path) -> None:  # noqa: ANN001
    _crate(tmp_path)
    client = _FakeClient()
    manager = manager_for(client)

    def methods() -> list[str]:
        sent = [method for method, _ in client.notifications]
        client.notifications.clear()
        return sent

    # An agent's edit: written to disk, then synced.
    manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=False)
    assert methods() == ['textDocument/didOpen', 'textDocument/didSave']
    manager.sync_document('src/lib.rs', 'pub fn g() {}\n', wait_for_diagnostics=False)
    assert methods() == ['textDocument/didChange', 'textDocument/didSave']
    manager.sync_document('src/lib.rs', 'pub fn g() {}\n', wait_for_diagnostics=False)
    assert methods() == [], 'the same text again starts no new check'

    # The editor's buffer may be unsaved; it reports its own saves.
    manager.sync_document('src/lib.rs', 'pub fn h() {}\n', wait_for_diagnostics=False, origin=DOC_ORIGIN_EDITOR)
    assert methods() == ['textDocument/didChange']


def test_other_servers_get_no_save_notification_from_a_sync() -> None:
    from clara_coder_backend.lsp.registry import get_lsp_server_plugin, iter_registered_lsp_server_ids

    assert [sid for sid in iter_registered_lsp_server_ids() if get_lsp_server_plugin(sid).checks_on_save] == ['rust']


def test_manager_pushes_a_newly_linked_project(manager_for, tmp_path: Path) -> None:  # noqa: ANN001
    _crate(tmp_path / 'one')
    second = _crate(tmp_path / 'two')
    client = _FakeClient()
    manager = manager_for(client)

    manager.sync_document('one/src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=False)
    assert client.configurations == []
    manager.sync_document('two/src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=False)

    assert len(client.configurations) == 1
    assert client.configurations[0]['linkedProjects'][-1] == str(second.resolve())


def test_an_untrusted_workspace_shows_as_a_setup_problem(manager_for, tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    _crate(tmp_path)
    monkeypatch.setattr(runtime_config, 'trusted_workspace_keys', frozenset())
    client = _FakeClient()
    manager = manager_for(client)

    with pytest.raises(LspServerNotInstalledError):
        manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=False)

    assert client.initialize_kwargs == {}, 'the server process is never started'
    entry = manager.dashboard_entry()
    assert entry['phase'] == 'crashed'
    assert entry['setupError'] is True
    assert entry['lastError'].startswith('Rust needs a trusted workspace.')


def test_server_health_reaches_the_dashboard_and_clears(manager_for, tmp_path: Path) -> None:  # noqa: ANN001
    _crate(tmp_path)
    manager = manager_for(_FakeClient())
    manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=False)
    assert 'languageStatus' not in manager.dashboard_entry()

    manager._handle_notification('experimental/serverStatus', {'health': 'warning', 'message': 'no rust-src'})
    assert manager.dashboard_entry()['languageStatus'] == 'no rust-src'

    manager._handle_notification('experimental/serverStatus', {'health': 'ok', 'quiescent': True})
    assert 'languageStatus' not in manager.dashboard_entry()


# --- an agent's edit waits for cargo check


def _progress(manager: SessionWorkspaceLspManager, kind: str, token: str = 'rust-analyzer/flycheck/0') -> None:
    manager._handle_notification('$/progress', {'token': token, 'value': {'kind': kind, 'title': 'cargo check'}})


def _publish_error(manager: SessionWorkspaceLspManager, workspace: Path, version: int) -> None:
    span = {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 3}}
    manager._handle_notification(
        'textDocument/publishDiagnostics',
        {
            'uri': (workspace / 'src' / 'lib.rs').resolve().as_uri(),
            'version': version,
            'diagnostics': [{'range': span, 'severity': 1, 'source': 'rustc', 'message': 'borrow of moved value'}],
        },
    )


def _later(steps: list[tuple[float, Any]]) -> threading.Thread:
    def run() -> None:
        for delay, step in steps:
            time.sleep(delay)
            step()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def test_an_agent_edit_waits_for_the_check_run_and_gets_its_errors(manager_for, tmp_path: Path) -> None:  # noqa: ANN001
    _crate(tmp_path)
    manager = manager_for(_FakeClient())
    events = _later(
        [
            (0.1, lambda: _progress(manager, 'begin')),
            (0.3, lambda: _publish_error(manager, tmp_path, 1)),
            (0.02, lambda: _progress(manager, 'end')),
        ]
    )
    started = time.monotonic()
    rows = manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=True)
    events.join()

    assert [row['message'] for row in rows] == ['borrow of moved value']
    assert manager.diagnostics_fresh('src/lib.rs') is True
    assert time.monotonic() - started < 2.0, 'it returns when the run ends, not after the whole wait window'


def test_the_run_a_save_cancels_does_not_end_the_wait(manager_for, tmp_path: Path) -> None:  # noqa: ANN001
    _crate(tmp_path)
    manager = manager_for(_FakeClient())
    _progress(manager, 'begin')
    events = _later(
        [
            (0.1, lambda: _progress(manager, 'end')),  # the run for the previous text, cancelled
            (0.03, lambda: _progress(manager, 'begin')),
            (0.3, lambda: _publish_error(manager, tmp_path, 1)),
            (0.02, lambda: _progress(manager, 'end')),
        ]
    )
    rows = manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=True)
    events.join()
    assert [row['message'] for row in rows] == ['borrow of moved value']


def test_a_check_still_running_at_the_deadline_leaves_diagnostics_unconfirmed(manager_for, tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    _crate(tmp_path)
    monkeypatch.setattr(lsp_manager_module, '_SAVE_CHECK_WAIT_S', 0.3)
    manager = manager_for(_FakeClient())
    events = _later([(0.05, lambda: _progress(manager, 'begin'))])
    rows = manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=True)
    events.join()
    assert rows == []
    assert manager.diagnostics_fresh('src/lib.rs') is False, 'cargo has not said yet whether the file is clean'


def test_with_no_check_run_the_usual_wait_applies(manager_for, tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    _crate(tmp_path)
    monkeypatch.setattr(lsp_manager_module, '_SAVE_CHECK_BEGIN_GRACE_S', 0.05)
    monkeypatch.setattr(lsp_manager_module, '_DIAG_WAIT_TIMEOUT_SLOW_S', 0.1)
    manager = manager_for(_FakeClient())
    assert manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=True) == []
    assert manager.diagnostics_fresh('src/lib.rs') is False, 'a server still loading the project has published nothing'


def test_no_save_is_reported_while_check_on_save_is_off(manager_for, tmp_path: Path, rust_settings) -> None:  # noqa: ANN001
    _crate(tmp_path)
    rust_settings.check_on_save = False
    client = _FakeClient()
    manager = manager_for(client)
    manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=False)
    assert [method for method, _ in client.notifications] == ['textDocument/didOpen']


def test_a_save_dropped_while_the_project_loads_is_reported_again(manager_for, tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    """rust-analyzer ignores a save that arrives before it has loaded the project."""

    _crate(tmp_path)
    monkeypatch.setattr(lsp_manager_module, '_SAVE_CHECK_BEGIN_GRACE_S', 0.2)
    client = _FakeClient()
    manager = manager_for(client)
    _progress(manager, 'begin', token='rustAnalyzer/Fetching')

    def saves() -> int:
        return sum(1 for method, _ in client.notifications if method == 'textDocument/didSave')

    def run_check_once_saved_again() -> None:
        deadline = time.monotonic() + 5
        while saves() < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        _progress(manager, 'begin')
        time.sleep(0.1)
        _publish_error(manager, tmp_path, 1)
        _progress(manager, 'end')

    events = _later(
        [
            (0.3, lambda: _progress(manager, 'end', token='rustAnalyzer/Fetching')),
            (0.0, run_check_once_saved_again),
        ]
    )
    rows = manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=True)
    events.join()

    assert saves() == 2
    assert [row['message'] for row in rows] == ['borrow of moved value']
    assert manager.diagnostics_fresh('src/lib.rs') is True


def test_a_project_still_loading_at_the_deadline_leaves_diagnostics_unconfirmed(manager_for, tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    _crate(tmp_path)
    monkeypatch.setattr(lsp_manager_module, '_SAVE_CHECK_WAIT_S', 0.3)
    manager = manager_for(_FakeClient())
    _progress(manager, 'begin', token='rustAnalyzer/Fetching')
    assert manager.sync_document('src/lib.rs', 'pub fn f() {}\n', wait_for_diagnostics=True) == []
    assert manager.diagnostics_fresh('src/lib.rs') is False
