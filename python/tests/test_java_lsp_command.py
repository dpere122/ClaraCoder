"""Tests for Eclipse JDT LS spawn command resolution."""

from __future__ import annotations

from pathlib import Path

import pytest

from nemo_backend.lsp import java_server
from nemo_backend.lsp.java_server import (
    JavaLspSetupError,
    build_java_initialization_options,
    build_java_lsp_command,
    get_java_lsp_cache_dir,
)


def test_build_java_lsp_command_env_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('NEMO_JAVA_LSP_COMMAND', 'custom_jdtls --stdio')
    cmd = build_java_lsp_command(tmp_path)
    assert cmd == ['custom_jdtls', '--stdio']


def test_get_java_lsp_cache_dir_from_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / 'cache'
    monkeypatch.setenv('NEMO_JAVA_LSP_CACHE_DIR', str(cache))
    assert get_java_lsp_cache_dir() == cache.resolve()


def test_build_java_lsp_command_uses_cached_product(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv('NEMO_JAVA_LSP_COMMAND', raising=False)
    cache = tmp_path / 'java-lsp'
    monkeypatch.setenv('NEMO_JAVA_LSP_CACHE_DIR', str(cache))
    monkeypatch.setenv('NEMO_JAVA_LSP_VERSION', '1.60.0')

    product = cache / 'jdtls' / '1.60.0'
    plugins = product / 'plugins'
    config = product / 'config_linux'
    plugins.mkdir(parents=True)
    config.mkdir(parents=True)
    launcher = plugins / 'org.eclipse.equinox.launcher_1.6.900.v20240613-2000.jar'
    launcher.write_bytes(b'jar')
    (product / '.nemo-ready').write_text('1.60.0\n', encoding='utf-8')

    fake_java = tmp_path / 'jdk' / 'bin' / 'java'
    fake_java.parent.mkdir(parents=True)
    fake_java.write_text('#!/bin/sh\n', encoding='utf-8')
    fake_java.chmod(0o755)

    monkeypatch.setattr(java_server, 'resolve_java_executable', lambda: fake_java.resolve())
    monkeypatch.setattr(java_server, '_platform_config_dirname', lambda: 'config_linux')

    project = tmp_path / 'proj'
    project.mkdir()
    (project / 'pom.xml').write_text('<project/>\n', encoding='utf-8')

    cmd = build_java_lsp_command(project)
    assert cmd[0] == str(fake_java.resolve())
    assert '-jar' in cmd
    assert str(launcher) in cmd
    assert '-configuration' in cmd
    assert '-data' in cmd
    data_idx = cmd.index('-data')
    assert Path(cmd[data_idx + 1]).is_dir()
    cfg_idx = cmd.index('-configuration')
    assert Path(cmd[cfg_idx + 1]).is_dir()


def test_build_java_lsp_command_missing_jdk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_JAVA_LSP_COMMAND', raising=False)
    monkeypatch.setenv('NEMO_JAVA_LSP_CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.delenv('JAVA_HOME', raising=False)
    monkeypatch.setattr(java_server.shutil, 'which', lambda _name: None)

    with pytest.raises(JavaLspSetupError, match='JDK 21'):
        build_java_lsp_command(tmp_path)


def test_build_java_initialization_options_enable_import() -> None:
    opts = build_java_initialization_options()
    java = opts['settings']['java']
    assert java['import']['maven']['enabled'] is True
    assert java['import']['gradle']['enabled'] is True
