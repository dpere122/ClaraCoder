"""Tests for Java Maven/Gradle project root resolution."""

from __future__ import annotations

from pathlib import Path

import pytest

from nemo_backend.lsp.java_project_root import is_java_project_root, resolve_java_project_root


def test_is_java_project_root_maven(tmp_path: Path) -> None:
    (tmp_path / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
    assert is_java_project_root(tmp_path)


def test_is_java_project_root_gradle(tmp_path: Path) -> None:
    (tmp_path / 'build.gradle.kts').write_text('plugins {}\n', encoding='utf-8')
    assert is_java_project_root(tmp_path)


def test_resolve_java_project_root_from_seed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_JAVA_LSP_PROJECT_ROOT', raising=False)
    root = tmp_path / 'app'
    src = root / 'src' / 'main' / 'java' / 'com' / 'example'
    src.mkdir(parents=True)
    (root / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
    (src / 'App.java').write_text('class App {}\n', encoding='utf-8')

    resolved = resolve_java_project_root(
        tmp_path,
        seed_relative_path='app/src/main/java/com/example/App.java',
    )
    assert resolved == root.resolve()


def test_resolve_java_project_root_env_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    nested = tmp_path / 'lib'
    nested.mkdir()
    (nested / 'build.gradle').write_text('apply plugin: "java"\n', encoding='utf-8')
    other = tmp_path / 'other'
    other.mkdir()
    (other / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
    monkeypatch.setenv('NEMO_JAVA_LSP_PROJECT_ROOT', 'lib')

    resolved = resolve_java_project_root(tmp_path, seed_relative_path='other/Main.java')
    assert resolved == nested.resolve()


def test_resolve_java_project_root_discovery(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_JAVA_LSP_PROJECT_ROOT', raising=False)
    deep = tmp_path / 'modules' / 'core'
    deep.mkdir(parents=True)
    (deep / 'settings.gradle').write_text('rootProject.name = "core"\n', encoding='utf-8')

    resolved = resolve_java_project_root(tmp_path, seed_relative_path=None, allow_workspace_walk=True)
    assert resolved == deep.resolve()


def test_resolve_java_project_root_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_JAVA_LSP_PROJECT_ROOT', raising=False)
    resolved = resolve_java_project_root(tmp_path, seed_relative_path=None, allow_workspace_walk=True)
    assert resolved == tmp_path.resolve()
