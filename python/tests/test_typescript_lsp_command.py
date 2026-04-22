"""Tests for typescript-language-server spawn command resolution."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from nemo_backend.lsp.typescript_server import build_typescript_lsp_command


def test_build_typescript_lsp_command_env_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('NEMO_TYPESCRIPT_LSP_COMMAND', 'custom_tls_ls --stdio')
    cmd = build_typescript_lsp_command(tmp_path)
    assert cmd == ['custom_tls_ls', '--stdio']


def test_build_typescript_lsp_command_prefers_local_bin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_TYPESCRIPT_LSP_COMMAND', raising=False)
    bin_dir = tmp_path / 'node_modules' / '.bin'
    bin_dir.mkdir(parents=True)
    if os.name == 'nt':
        script = bin_dir / 'typescript-language-server.cmd'
        script.write_text('@echo off\n', encoding='utf-8')
    else:
        script = bin_dir / 'typescript-language-server'
        script.write_text('#!/bin/sh\n', encoding='utf-8')
        script.chmod(0o755)
    cmd = build_typescript_lsp_command(tmp_path)
    assert cmd[0] == str(script)
    assert cmd[1:] == ['--stdio']


def test_build_typescript_lsp_command_walks_up_for_monorepo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_TYPESCRIPT_LSP_COMMAND', raising=False)
    root = tmp_path / 'repo'
    nested = root / 'packages' / 'app'
    nested.mkdir(parents=True)
    bin_dir = root / 'node_modules' / '.bin'
    bin_dir.mkdir(parents=True)
    if os.name == 'nt':
        script = bin_dir / 'typescript-language-server.cmd'
        script.write_text('@echo off\n', encoding='utf-8')
    else:
        script = bin_dir / 'typescript-language-server'
        script.write_text('#!/bin/sh\n', encoding='utf-8')
        script.chmod(0o755)
    cmd = build_typescript_lsp_command(nested)
    assert cmd[0] == str(script)
    assert cmd[1:] == ['--stdio']


def test_build_typescript_lsp_command_npx_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_TYPESCRIPT_LSP_COMMAND', raising=False)
    cmd = build_typescript_lsp_command(tmp_path)
    assert 'typescript-language-server' in cmd
    assert cmd[-1] == '--stdio'
    assert cmd[0].lower().endswith('npx.cmd') or cmd[0].endswith('npx')
