"""TypeScript LSP plugin project-root isolation (no live vtsls process)."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp.plugins import typescript_plugin as typescript_plugin_mod
from clara_coder_backend.lsp.plugins.typescript_plugin import TypescriptLspPlugin, TypescriptPluginState
from clara_coder_backend.lsp.typescript_server import TypescriptLspSpawn


@pytest.fixture(autouse=True)
def _stub_typescript_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_TYPESCRIPT_LSP_PROJECT_ROOT', raising=False)
    monkeypatch.setattr(
        typescript_plugin_mod,
        'resolve_typescript_lsp_spawn',
        lambda root: TypescriptLspSpawn(['vtsls', '--stdio']),
    )


def _session_with_ts_cache(path: Path | str) -> SessionState:
    session = SessionState()
    session.lsp.typescript_lsp_resolved_root = str(path)
    return session


def test_compute_start_params_ignores_cache_outside_workspace(tmp_path: Path) -> None:
    real_ws = tmp_path / 'workspace'
    real_app = real_ws / 'app'
    real_app.mkdir(parents=True)
    (real_app / 'package.json').write_text('{}\n', encoding='utf-8')

    overlay = tmp_path / 'overlay'
    overlay.mkdir()
    (overlay / 'package.json').write_text('{}\n', encoding='utf-8')

    plugin = TypescriptLspPlugin()
    state = TypescriptPluginState()
    session = _session_with_ts_cache(real_app)

    params = plugin.compute_start_params(
        session=session,
        workspace_root=overlay,
        state=state,
        session_id='sess',
        scope='staging',
    )
    assert params.lsp_cwd == overlay.resolve()


def test_after_shutdown_staging_does_not_clear_workspace_cache(tmp_path: Path) -> None:
    ws = tmp_path / 'ws'
    ws.mkdir()
    (ws / 'package.json').write_text('{}\n', encoding='utf-8')
    overlay = tmp_path / 'overlay'
    overlay.mkdir()
    (overlay / 'package.json').write_text('{}\n', encoding='utf-8')

    plugin = TypescriptLspPlugin()
    state = TypescriptPluginState()
    session = _session_with_ts_cache(ws)

    plugin.compute_start_params(
        session=session,
        workspace_root=overlay,
        state=state,
        session_id='sess',
        scope='staging',
    )
    plugin.after_shutdown(session, state)
    assert Path(session.lsp.typescript_lsp_resolved_root).resolve() == ws.resolve()


def test_after_shutdown_workspace_clears_matching_cache(tmp_path: Path) -> None:
    ws = tmp_path / 'ws'
    ws.mkdir()
    (ws / 'package.json').write_text('{}\n', encoding='utf-8')

    plugin = TypescriptLspPlugin()
    state = TypescriptPluginState()
    session = SessionState()

    params = plugin.compute_start_params(
        session=session,
        workspace_root=ws,
        state=state,
        session_id='sess',
        scope='workspace',
    )
    plugin.on_after_client_started(
        session=session,
        workspace_root=ws,
        state=state,
        lsp_cwd=params.lsp_cwd,
    )
    assert session.lsp.typescript_lsp_resolved_root
    plugin.after_shutdown(session, state)
    assert session.lsp.typescript_lsp_resolved_root == ''
