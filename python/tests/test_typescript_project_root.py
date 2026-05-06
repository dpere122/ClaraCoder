"""Tests for TypeScript/Node project root auto-detection."""

from __future__ import annotations

from pathlib import Path

import pytest

from nemo_backend.lsp.typescript_project_root import (
    package_node_modules_link_rels,
    resolve_typescript_project_root,
)


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


def test_resolve_plain_js_package_with_node_modules(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Packages without a typescript devDependency still count once node_modules is populated."""

    monkeypatch.delenv('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT', raising=False)
    ws = tmp_path / 'ws'
    app = ws / 'lib'
    app.mkdir(parents=True)
    (app / 'package.json').write_text('{"name":"lib","dependencies":{"lodash":"^4"}}', encoding='utf-8')
    nm = app / 'node_modules' / 'lodash'
    nm.mkdir(parents=True)
    (nm / 'package.json').write_text('{}', encoding='utf-8')
    (app / 'index.js').write_text('export {}', encoding='utf-8')

    got = resolve_typescript_project_root(ws, seed_relative_path='lib/index.js')
    assert got.resolve() == app.resolve()


def test_resolve_discovers_deep_nested_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Discovery depth must exceed shallow monorepo layouts (previously capped at 6)."""

    monkeypatch.delenv('NEMO_TYPESCRIPT_LSP_PROJECT_ROOT', raising=False)
    ws = tmp_path / 'ws'
    deep = ws / 'a' / 'b' / 'c' / 'd' / 'e' / 'f' / 'app'
    deep.mkdir(parents=True)
    _touch_ts_package(deep)

    got = resolve_typescript_project_root(ws, seed_relative_path=None)
    assert got.resolve() == deep.resolve()


def test_package_node_modules_link_rels(tmp_path: Path) -> None:
    ws = tmp_path / 'w'
    r1 = ws / 'src' / 'renderer'
    r1.mkdir(parents=True)
    (r1 / 'package.json').write_text('{"name":"r"}', encoding='utf-8')
    (r1 / 'node_modules' / 'x').mkdir(parents=True)
    r2 = ws / 'pkg'
    r2.mkdir(parents=True)
    (r2 / 'package.json').write_text('{"name":"p"}', encoding='utf-8')
    (r2 / 'node_modules' / 'y').mkdir(parents=True)

    got = package_node_modules_link_rels(ws)
    assert 'pkg/node_modules' in got
    assert 'src/renderer/node_modules' in got
