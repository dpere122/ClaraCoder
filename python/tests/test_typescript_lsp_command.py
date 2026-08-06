"""Tests for vtsls spawn command resolution (incl. bundled ELECTRON_RUN_AS_NODE path)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from clara_coder_backend.lsp.typescript_server import (
    build_typescript_lsp_command,
    resolve_typescript_lsp_spawn,
)


def _no_bundled_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure the bundled-via-Electron path is not selected (npx fallback)."""

    monkeypatch.delenv('CLARA_ELECTRON_EXEC_PATH', raising=False)
    monkeypatch.delenv('CLARA_VTSLS_BUNDLED_ENTRY', raising=False)


def test_build_typescript_lsp_command_env_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_TYPESCRIPT_LSP_COMMAND', 'custom_tls_ls --stdio')
    cmd = build_typescript_lsp_command(tmp_path)
    assert cmd == ['custom_tls_ls', '--stdio']
    # Override wins even when a bundled entry is configured.
    monkeypatch.setenv('CLARA_ELECTRON_EXEC_PATH', '/fake/electron')
    monkeypatch.setenv('CLARA_VTSLS_BUNDLED_ENTRY', '/fake/vtsls.js')
    assert build_typescript_lsp_command(tmp_path) == ['custom_tls_ls', '--stdio']


def test_build_typescript_lsp_command_prefers_local_bin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_TYPESCRIPT_LSP_COMMAND', raising=False)
    _no_bundled_env(monkeypatch)
    bin_dir = tmp_path / 'node_modules' / '.bin'
    bin_dir.mkdir(parents=True)
    if os.name == 'nt':
        script = bin_dir / 'vtsls.cmd'
        script.write_text('@echo off\n', encoding='utf-8')
    else:
        script = bin_dir / 'vtsls'
        script.write_text('#!/bin/sh\n', encoding='utf-8')
        script.chmod(0o755)
    cmd = build_typescript_lsp_command(tmp_path)
    assert cmd[0] == str(script)
    assert cmd[1:] == ['--stdio']
    assert resolve_typescript_lsp_spawn(tmp_path).env is None


def test_build_typescript_lsp_command_walks_up_for_monorepo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_TYPESCRIPT_LSP_COMMAND', raising=False)
    _no_bundled_env(monkeypatch)
    root = tmp_path / 'repo'
    nested = root / 'packages' / 'app'
    nested.mkdir(parents=True)
    bin_dir = root / 'node_modules' / '.bin'
    bin_dir.mkdir(parents=True)
    if os.name == 'nt':
        script = bin_dir / 'vtsls.cmd'
        script.write_text('@echo off\n', encoding='utf-8')
    else:
        script = bin_dir / 'vtsls'
        script.write_text('#!/bin/sh\n', encoding='utf-8')
        script.chmod(0o755)
    cmd = build_typescript_lsp_command(nested)
    assert cmd[0] == str(script)
    assert cmd[1:] == ['--stdio']


def test_build_typescript_lsp_command_npx_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_TYPESCRIPT_LSP_COMMAND', raising=False)
    _no_bundled_env(monkeypatch)
    cmd = build_typescript_lsp_command(tmp_path)
    assert cmd[-1] == '--stdio'
    assert cmd[-2] == 'vtsls'
    assert '-p' in cmd
    assert '@vtsls/language-server' in cmd
    assert cmd[0].lower().endswith('npx.cmd') or cmd[0].endswith('npx')
    assert resolve_typescript_lsp_spawn(tmp_path).env is None


def test_build_typescript_lsp_command_uses_bundled_via_electron(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When no workspace bin exists, the bundled vtsls runs via the Electron binary in Node mode."""

    monkeypatch.delenv('CLARA_TYPESCRIPT_LSP_COMMAND', raising=False)
    fake_electron = tmp_path / 'electron'
    fake_electron.write_text('#!/bin/sh\n', encoding='utf-8')
    fake_electron.chmod(0o755)
    fake_entry = tmp_path / 'vtsls.js'
    fake_entry.write_text('// vtsls\n', encoding='utf-8')
    monkeypatch.setenv('CLARA_ELECTRON_EXEC_PATH', str(fake_electron))
    monkeypatch.setenv('CLARA_VTSLS_BUNDLED_ENTRY', str(fake_entry))

    spawn = resolve_typescript_lsp_spawn(tmp_path)
    assert spawn.command == [str(fake_electron), str(fake_entry), '--stdio']
    assert spawn.env == {'ELECTRON_RUN_AS_NODE': '1'}
    assert build_typescript_lsp_command(tmp_path) == spawn.command


def test_build_typescript_lsp_command_prefers_local_bin_over_bundled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A workspace node_modules/.bin/vtsls takes precedence over the bundled runtime."""

    monkeypatch.delenv('CLARA_TYPESCRIPT_LSP_COMMAND', raising=False)
    fake_electron = tmp_path / 'electron'
    fake_electron.write_text('#!/bin/sh\n', encoding='utf-8')
    fake_electron.chmod(0o755)
    fake_entry = tmp_path / 'vtsls.js'
    fake_entry.write_text('// vtsls\n', encoding='utf-8')
    monkeypatch.setenv('CLARA_ELECTRON_EXEC_PATH', str(fake_electron))
    monkeypatch.setenv('CLARA_VTSLS_BUNDLED_ENTRY', str(fake_entry))

    local_bin_dir = tmp_path / 'node_modules' / '.bin'
    local_bin_dir.mkdir(parents=True)
    if os.name == 'nt':
        local_script = local_bin_dir / 'vtsls.cmd'
        local_script.write_text('@echo off\n', encoding='utf-8')
    else:
        local_script = local_bin_dir / 'vtsls'
        local_script.write_text('#!/bin/sh\n', encoding='utf-8')
        local_script.chmod(0o755)
    spawn = resolve_typescript_lsp_spawn(tmp_path)
    assert spawn.command[0] == str(local_script)
    assert spawn.command[1:] == ['--stdio']
    assert spawn.env is None


def test_build_typescript_lsp_command_bundled_ignored_when_paths_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bundled env pointing at non-existent files falls back to npx (no silent broken spawn)."""

    monkeypatch.delenv('CLARA_TYPESCRIPT_LSP_COMMAND', raising=False)
    monkeypatch.setenv('CLARA_ELECTRON_EXEC_PATH', str(tmp_path / 'no-electron'))
    monkeypatch.setenv('CLARA_VTSLS_BUNDLED_ENTRY', str(tmp_path / 'no-vtsls.js'))
    cmd = build_typescript_lsp_command(tmp_path)
    assert cmd[0].lower().endswith('npx.cmd') or cmd[0].endswith('npx')
    assert cmd[-2] == 'vtsls'
