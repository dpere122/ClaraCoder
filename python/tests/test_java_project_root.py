"""Tests for Java project root and layout (Maven/Gradle/Eclipse/loose) resolution."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.lsp.java_project_root import (
    JAVA_LAYOUT_ECLIPSE,
    JAVA_LAYOUT_GRADLE,
    JAVA_LAYOUT_LOOSE,
    classify_java_project_dir,
    detect_java_project_layout,
    is_java_project_root,
    resolve_java_project_root,
)


def test_is_java_project_root_maven(tmp_path: Path) -> None:
    (tmp_path / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
    assert is_java_project_root(tmp_path)


def test_is_java_project_root_gradle(tmp_path: Path) -> None:
    (tmp_path / 'build.gradle.kts').write_text('plugins {}\n', encoding='utf-8')
    assert is_java_project_root(tmp_path)


def test_resolve_java_project_root_from_seed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
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
    monkeypatch.setenv('CLARA_JAVA_LSP_PROJECT_ROOT', 'lib')

    resolved = resolve_java_project_root(tmp_path, seed_relative_path='other/Main.java')
    assert resolved == nested.resolve()


def test_resolve_java_project_root_discovery(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
    deep = tmp_path / 'modules' / 'core'
    deep.mkdir(parents=True)
    (deep / 'settings.gradle').write_text('rootProject.name = "core"\n', encoding='utf-8')

    resolved = resolve_java_project_root(tmp_path, seed_relative_path=None, allow_workspace_walk=True)
    assert resolved == deep.resolve()


def test_resolve_java_project_root_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
    resolved = resolve_java_project_root(tmp_path, seed_relative_path=None, allow_workspace_walk=True)
    assert resolved == tmp_path.resolve()


def test_seed_without_build_file_is_loose_even_with_other_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
    tools = tmp_path / 'tools'
    tools.mkdir()
    (tools / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
    scratch = tmp_path / 'scratch'
    scratch.mkdir()
    (scratch / 'Foo.java').write_text('class Foo {}\n', encoding='utf-8')

    layout = detect_java_project_layout(tmp_path, seed_relative_path='scratch/Foo.java')
    assert layout.kind == JAVA_LAYOUT_LOOSE
    assert layout.root == tmp_path.resolve()
    assert layout.config_path is None


def test_gradle_subproject_lifts_to_settings_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
    (tmp_path / 'settings.gradle.kts').write_text('include("app")\n', encoding='utf-8')
    app = tmp_path / 'app'
    src = app / 'src' / 'main' / 'java'
    src.mkdir(parents=True)
    (app / 'build.gradle.kts').write_text('plugins { java }\n', encoding='utf-8')

    layout = detect_java_project_layout(tmp_path, seed_relative_path='app/src/main/java/Main.java')
    assert layout.kind == JAVA_LAYOUT_GRADLE
    assert layout.root == tmp_path.resolve()


def test_eclipse_project_needs_project_and_classpath(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
    proj = tmp_path / 'legacy'
    (proj / 'src').mkdir(parents=True)
    (proj / '.project').write_text('<projectDescription/>\n', encoding='utf-8')
    assert classify_java_project_dir(proj) is None
    (proj / '.classpath').write_text('<classpath/>\n', encoding='utf-8')

    layout = detect_java_project_layout(tmp_path, seed_relative_path='legacy/src/A.java')
    assert layout.kind == JAVA_LAYOUT_ECLIPSE
    assert layout.root == proj.resolve()


def test_build_file_wins_over_eclipse_metadata(tmp_path: Path) -> None:
    (tmp_path / '.project').write_text('<projectDescription/>\n', encoding='utf-8')
    (tmp_path / '.classpath').write_text('<classpath/>\n', encoding='utf-8')
    (tmp_path / 'build.gradle').write_text('apply plugin: "java"\n', encoding='utf-8')
    assert classify_java_project_dir(tmp_path) == JAVA_LAYOUT_GRADLE


def test_clara_java_json_marks_configured_loose_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_PROJECT_ROOT', raising=False)
    sub = tmp_path / 'demo'
    (sub / '.clara').mkdir(parents=True)
    (sub / '.clara' / 'java.json').write_text('{}\n', encoding='utf-8')

    layout = detect_java_project_layout(tmp_path, seed_relative_path='demo/src/A.java')
    assert layout.kind == JAVA_LAYOUT_LOOSE
    assert layout.root == sub.resolve()
    assert layout.config_path == sub.resolve() / '.clara' / 'java.json'
