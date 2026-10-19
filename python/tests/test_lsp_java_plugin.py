"""Java LSP plugin project-root isolation (no live JDT process)."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp.plugins import java_plugin as java_plugin_mod
from clara_coder_backend.lsp.plugins.java_plugin import JavaLspPlugin, JavaPluginState


@pytest.fixture(autouse=True)
def _stub_java_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
    monkeypatch.setattr(
        java_plugin_mod,
        'build_java_lsp_command',
        lambda root, instance_key='': ['jdtls', str(root), instance_key],
    )


def _session_with_java_cache(path: Path | str) -> SessionState:
    session = SessionState()
    session.lsp.java_lsp_resolved_root = str(path)
    return session


def test_compute_start_params_ignores_cache_outside_workspace(tmp_path: Path) -> None:
    real_ws = tmp_path / 'workspace'
    real_app = real_ws / 'app'
    real_app.mkdir(parents=True)
    (real_app / 'pom.xml').write_text('<project/>\n', encoding='utf-8')

    overlay = tmp_path / 'overlay'
    overlay.mkdir()
    (overlay / 'pom.xml').write_text('<project/>\n', encoding='utf-8')

    plugin = JavaLspPlugin()
    state = JavaPluginState()
    session = _session_with_java_cache(real_app)

    params = plugin.compute_start_params(
        session=session,
        workspace_root=overlay,
        state=state,
        session_id='sess',
        scope='staging',
    )
    assert params.lsp_cwd == overlay.resolve()


def test_compute_start_params_prefers_sync_root_over_stale_cache(tmp_path: Path) -> None:
    ws = tmp_path / 'ws'
    mod_a = ws / 'module-a'
    mod_b = ws / 'module-b'
    src_b = mod_b / 'src'
    mod_a.mkdir(parents=True)
    src_b.mkdir(parents=True)
    (mod_a / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
    (mod_b / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
    (src_b / 'App.java').write_text('class App {}\n', encoding='utf-8')

    plugin = JavaLspPlugin()
    state = JavaPluginState()
    session = _session_with_java_cache(mod_a)

    restart = plugin.on_before_sync_document(
        session=session,
        workspace_root=ws,
        relative_posix_path='module-b/src/App.java',
        state=state,
        client_running=False,
    )
    assert restart is False

    params = plugin.compute_start_params(
        session=session,
        workspace_root=ws,
        state=state,
        session_id='sess',
        scope='workspace',
    )
    assert params.lsp_cwd == mod_b.resolve()


def test_compute_start_params_uses_in_workspace_cache_without_seed(tmp_path: Path) -> None:
    ws = tmp_path / 'ws'
    nested = ws / 'lib'
    nested.mkdir(parents=True)
    (nested / 'pom.xml').write_text('<project/>\n', encoding='utf-8')

    plugin = JavaLspPlugin()
    state = JavaPluginState()
    session = _session_with_java_cache(nested)

    params = plugin.compute_start_params(
        session=session,
        workspace_root=ws,
        state=state,
        session_id='sess',
        scope='workspace',
    )
    assert params.lsp_cwd == nested.resolve()


def _journal_workspace(tmp_path: Path) -> Path:
    ws = tmp_path / 'ws'
    pkg = ws / 'src' / 'journal'
    pkg.mkdir(parents=True)
    for name in ('Entry', 'JournalApp'):
        (pkg / f'{name}.java').write_text(f'package journal;\n\nclass {name} {{}}\n', encoding='utf-8')
    return ws


def _start(plugin: JavaLspPlugin, state: JavaPluginState, ws: Path):
    return plugin.compute_start_params(
        session=SessionState(),
        workspace_root=ws,
        state=state,
        session_id='sess',
        scope='workspace',
    )


def _sync(plugin: JavaLspPlugin, state: JavaPluginState, ws: Path, rel: str, text: str | None = None) -> bool:
    return plugin.on_before_sync_document(
        session=SessionState(),
        workspace_root=ws,
        relative_posix_path=rel,
        state=state,
        client_running=True,
        text=text,
    )


def test_loose_folder_sends_inferred_source_paths(tmp_path: Path) -> None:
    ws = _journal_workspace(tmp_path)
    plugin = JavaLspPlugin()
    state = JavaPluginState()
    plugin.on_before_sync_document(
        session=SessionState(),
        workspace_root=ws,
        relative_posix_path='src/journal/Entry.java',
        state=state,
        client_running=False,
        text='package journal;\n',
    )
    params = _start(plugin, state, ws)
    java = params.init_options['settings']['java']
    assert java['project'] == {'sourcePaths': ['src']}
    assert java['configuration']['updateBuildConfiguration'] == 'automatic'
    assert params.command[-1] == 'sess:workspace:loose'


def test_build_tool_project_gets_no_path_settings(tmp_path: Path) -> None:
    ws = _journal_workspace(tmp_path)
    (ws / 'build.gradle').write_text('apply plugin: "java"\n', encoding='utf-8')
    plugin = JavaLspPlugin()
    state = JavaPluginState()
    _sync(plugin, state, ws, 'src/journal/Entry.java', 'package journal;\n')
    params = _start(plugin, state, ws)
    java = params.init_options['settings']['java']
    assert 'project' not in java
    assert 'runtimes' not in java['configuration']
    assert params.command[-1] == 'sess:workspace:gradle'


def test_adding_build_file_restarts_with_new_kind(tmp_path: Path) -> None:
    ws = _journal_workspace(tmp_path)
    plugin = JavaLspPlugin()
    state = JavaPluginState()
    _start(plugin, state, ws)
    assert _sync(plugin, state, ws, 'src/journal/Entry.java', 'package journal;\n') is False

    (ws / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
    assert _sync(plugin, state, ws, 'src/journal/Entry.java', 'package journal;\n') is True
    params = _start(plugin, state, ws)
    assert params.command[-1] == 'sess:workspace:maven'
    assert 'project' not in params.init_options['settings']['java']


def test_java_json_change_pushes_settings_without_restart(tmp_path: Path) -> None:
    ws = _journal_workspace(tmp_path)
    plugin = JavaLspPlugin()
    state = JavaPluginState()
    _start(plugin, state, ws)
    assert plugin.take_pending_initialization_options(state) is None

    (ws / '.clara').mkdir()
    (ws / '.clara' / 'java.json').write_text('{"referencedLibraries": ["C:/jfx/*.jar"]}\n', encoding='utf-8')
    assert _sync(plugin, state, ws, 'src/journal/Entry.java', 'package journal;\n') is False
    pending = plugin.take_pending_initialization_options(state)
    assert pending is not None
    assert pending['settings']['java']['project'] == {
        'sourcePaths': ['src'],
        'referencedLibraries': ['C:/jfx/*.jar'],
    }
    assert plugin.take_pending_initialization_options(state) is None
    # Unchanged config on the next sync pushes nothing.
    assert _sync(plugin, state, ws, 'src/journal/Entry.java', 'package journal;\n') is False
    assert plugin.take_pending_initialization_options(state) is None


def test_new_unsaved_file_adds_source_root(tmp_path: Path) -> None:
    ws = _journal_workspace(tmp_path)
    plugin = JavaLspPlugin()
    state = JavaPluginState()
    _start(plugin, state, ws)

    # Not on disk yet (staged edit): only the synced text knows its package.
    text = 'package journal;\nclass EntryTest {}\n'
    assert _sync(plugin, state, ws, 'test/journal/EntryTest.java', text) is False
    pending = plugin.take_pending_initialization_options(state)
    assert pending is not None
    assert pending['settings']['java']['project']['sourcePaths'] == ['src', 'test']
