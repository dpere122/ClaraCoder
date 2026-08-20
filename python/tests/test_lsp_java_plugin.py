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
    monkeypatch.setattr(java_plugin_mod, 'build_java_lsp_command', lambda root, instance_key='': ['jdtls', str(root)])


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
