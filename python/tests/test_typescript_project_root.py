"""Tests for TypeScript/Node project root auto-detection."""

from __future__ import annotations

from pathlib import Path

import pytest

from nemo_backend.lsp.typescript_project_root import resolve_typescript_project_root


def _touch_ts_package(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / 'package.json').write_text('{"name":"x","devDependencies":{"typescript":"^5.0.0"}}', encoding='utf-8')
    nm = root / 'node_modules' / 'typescript'
    nm.mkdir(parents=True)
    (nm / 'package.json').write_text('{"name":"typescript"}', encoding='utf-8')


def test_resolve_prefers_walk_up_from_seed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT', raising=False)
    ws = tmp_path / 'repo'
    app = ws / 'src' / 'renderer'
    app.mkdir(parents=True)
    _touch_ts_package(app)
    (app / 'main.ts').write_text('export {}', encoding='utf-8')

    got = resolve_typescript_project_root(ws, seed_relative_path='src/renderer/main.ts')
    assert got.resolve() == app.resolve()


def test_resolve_discovers_deepest_nested_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT', raising=False)
    ws = tmp_path / 'monorepo'
    ws.mkdir()
    shallow = ws / 'pkg-a'
    shallow.mkdir(parents=True)
    _touch_ts_package(shallow)
    deep = ws / 'packages' / 'web' / 'app'
    deep.mkdir(parents=True)
    _touch_ts_package(deep)

    got = resolve_typescript_project_root(ws, seed_relative_path=None)
    assert got.resolve() == deep.resolve()


def test_resolve_env_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = tmp_path / 'w'
    target = ws / 'nested' / 't'
    target.mkdir(parents=True)
    _touch_ts_package(target)
    monkeypatch.setenv('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT', str(target))

    other = ws / 'other'
    other.mkdir(parents=True)
    _touch_ts_package(other)
    got = resolve_typescript_project_root(ws, seed_relative_path='other/index.ts')
    assert got.resolve() == target.resolve()


def test_resolve_env_relative_to_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = tmp_path / 'w'
    app = ws / 'app'
    app.mkdir(parents=True)
    _touch_ts_package(app)
    monkeypatch.setenv('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT', 'app')

    got = resolve_typescript_project_root(ws, seed_relative_path=None)
    assert got.resolve() == app.resolve()


def test_resolve_falls_back_to_workspace_when_no_packages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT', raising=False)
    ws = tmp_path / 'empty'
    ws.mkdir()
    got = resolve_typescript_project_root(ws, seed_relative_path=None)
    assert got.resolve() == ws.resolve()
