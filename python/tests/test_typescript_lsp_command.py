"""Tests for vtsls spawn resolution: overrides, workspace bin, the managed install and its absence."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp import typescript_server
from clara_coder_backend.lsp.plugins import typescript_plugin as typescript_plugin_mod
from clara_coder_backend.lsp.plugins.typescript_plugin import TypescriptLspPlugin
from clara_coder_backend.lsp.server_plugin import LspServerNotInstalledError
from clara_coder_backend.lsp.typescript_server import resolve_typescript_lsp_spawn
from clara_coder_backend.runtime.deps.providers import vtsls


@pytest.fixture
def runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An empty runtime dir with no overrides and no Electron path."""

    runtime_dir = tmp_path / 'runtime'
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(runtime_dir))
    monkeypatch.delenv('CLARA_TYPESCRIPT_LSP_COMMAND', raising=False)
    monkeypatch.delenv('CLARA_ELECTRON_EXEC_PATH', raising=False)
    return runtime_dir


def _install_managed(runtime: Path) -> Path:
    version_dir = runtime / 'vtsls' / vtsls.DEFAULT_TAG
    entry = version_dir.joinpath(*vtsls.ENTRY_RELATIVE.parts)
    entry.parent.mkdir(parents=True)
    entry.write_text('// vtsls\n', encoding='utf-8')
    vtsls.write_ready_marker(version_dir, vtsls.DEFAULT_TAG)
    return entry


def _fake_electron(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    electron = tmp_path / 'electron'
    electron.write_text('#!/bin/sh\n', encoding='utf-8')
    electron.chmod(0o755)
    monkeypatch.setenv('CLARA_ELECTRON_EXEC_PATH', str(electron))
    return electron


def _workspace_bin(root: Path) -> Path:
    bin_dir = root / 'node_modules' / '.bin'
    bin_dir.mkdir(parents=True)
    if os.name == 'nt':
        script = bin_dir / 'vtsls.cmd'
        script.write_text('@echo off\n', encoding='utf-8')
    else:
        script = bin_dir / 'vtsls'
        script.write_text('#!/bin/sh\n', encoding='utf-8')
        script.chmod(0o755)
    return script


def _start_params(workspace: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN202
    """``compute_start_params`` with the real resolver (conftest stubs it for every other test)."""

    monkeypatch.setattr(typescript_plugin_mod, 'resolve_typescript_lsp_spawn', resolve_typescript_lsp_spawn)
    (workspace / 'package.json').write_text('{}\n', encoding='utf-8')
    plugin = TypescriptLspPlugin()
    return plugin.compute_start_params(session=SessionState(), workspace_root=workspace, state=plugin.create_state())


def test_env_override_wins_over_everything(tmp_path: Path, runtime: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_managed(runtime)
    _fake_electron(tmp_path, monkeypatch)
    _workspace_bin(tmp_path)
    monkeypatch.setenv('CLARA_TYPESCRIPT_LSP_COMMAND', 'custom_tls_ls --stdio')

    spawn = resolve_typescript_lsp_spawn(tmp_path)

    assert spawn is not None
    assert spawn.command == ['custom_tls_ls', '--stdio']
    assert spawn.env is None


def test_workspace_bin_wins_over_the_managed_install(
    tmp_path: Path, runtime: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_managed(runtime)
    _fake_electron(tmp_path, monkeypatch)
    workspace = tmp_path / 'ws'
    script = _workspace_bin(workspace)

    spawn = resolve_typescript_lsp_spawn(workspace)

    assert spawn is not None
    assert spawn.command == [str(script), '--stdio']
    assert spawn.env is None


def test_workspace_bin_is_found_from_a_monorepo_package(runtime: Path, tmp_path: Path) -> None:
    root = tmp_path / 'repo'
    nested = root / 'packages' / 'app'
    nested.mkdir(parents=True)
    script = _workspace_bin(root)

    spawn = resolve_typescript_lsp_spawn(nested)

    assert spawn is not None
    assert spawn.command == [str(script), '--stdio']


def test_managed_install_runs_via_electron_as_node(
    tmp_path: Path, runtime: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = _install_managed(runtime)
    electron = _fake_electron(tmp_path, monkeypatch)
    workspace = tmp_path / 'ws'
    workspace.mkdir()

    spawn = resolve_typescript_lsp_spawn(workspace)

    assert spawn is not None
    assert spawn.command == [str(electron), str(entry), '--stdio']
    assert spawn.env == {'ELECTRON_RUN_AS_NODE': '1'}

    params = _start_params(workspace, monkeypatch)
    assert params.command == spawn.command
    assert params.env == {'ELECTRON_RUN_AS_NODE': '1'}


def test_not_installed_asks_for_the_dependency_and_never_uses_npx(
    tmp_path: Path, runtime: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_electron(tmp_path, monkeypatch)
    workspace = tmp_path / 'ws'
    workspace.mkdir()

    assert resolve_typescript_lsp_spawn(workspace) is None
    with pytest.raises(LspServerNotInstalledError, match='Open Dependencies and download “TypeScript/JS LSP \\(vtsls\\)”'):
        _start_params(workspace, monkeypatch)


def test_installed_without_electron_names_the_missing_path(
    tmp_path: Path, runtime: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_managed(runtime)
    workspace = tmp_path / 'ws'
    workspace.mkdir()

    assert resolve_typescript_lsp_spawn(workspace) is None
    with pytest.raises(LspServerNotInstalledError, match='CLARA_ELECTRON_EXEC_PATH is not set'):
        _start_params(workspace, monkeypatch)

    missing = tmp_path / 'no-electron'
    monkeypatch.setenv('CLARA_ELECTRON_EXEC_PATH', str(missing))
    assert resolve_typescript_lsp_spawn(workspace) is None
    with pytest.raises(LspServerNotInstalledError, match='does not exist'):
        _start_params(workspace, monkeypatch)


def test_no_npx_or_bundled_entry_left_in_the_resolver() -> None:
    source = Path(typescript_server.__file__).read_text(encoding='utf-8')
    assert 'npx' not in source
    assert 'CLARA_VTSLS_BUNDLED_ENTRY' not in source
