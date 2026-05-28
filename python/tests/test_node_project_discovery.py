"""npm workspace project discovery for dependency management."""

from __future__ import annotations

from pathlib import Path

import pytest

from nemo_backend.node_project_discovery import (
    discover_workspace_npm_projects,
    format_npm_discovery_report,
)


def test_discover_finds_root_and_nested_packages(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / 'package.json').write_text(
        '{"name":"root","version":"1.0.0","scripts":{"build":"tsc"},"dependencies":{"lodash":"^4"}}',
        encoding='utf-8',
    )
    (root / 'package-lock.json').write_text('{}', encoding='utf-8')
    app = root / 'apps' / 'web'
    app.mkdir(parents=True)
    (app / 'package.json').write_text(
        '{"name":"web","private":true,"devDependencies":{"typescript":"^5.0.0"}}',
        encoding='utf-8',
    )

    rows = discover_workspace_npm_projects(root)
    rels = {row['relativeDir'] for row in rows}
    assert rels == {'.', 'apps/web'}

    root_row = next(r for r in rows if r['relativeDir'] == '.')
    assert root_row['name'] == 'root'
    assert root_row['packageManager'] == 'npm'
    assert root_row['lockfiles'] == ['package-lock.json']
    assert root_row['scripts'] == ['build']
    assert root_row['dependencyCounts']['dependencies'] == 1

    web_row = next(r for r in rows if r['relativeDir'] == 'apps/web')
    assert web_row['private'] is True
    assert web_row['typescriptDeclared'] is True


def test_discover_scoped_to_subdirectory(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / 'package.json').write_text('{"name":"root"}', encoding='utf-8')
    pkg = root / 'packages' / 'lib'
    pkg.mkdir(parents=True)
    (pkg / 'package.json').write_text('{"name":"lib"}', encoding='utf-8')

    rows = discover_workspace_npm_projects(root, scope_dir=pkg)
    assert len(rows) == 1
    assert rows[0]['relativeDir'] == 'packages/lib'


def test_discover_skips_node_modules(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / 'package.json').write_text('{"name":"root"}', encoding='utf-8')
    nested = root / 'node_modules' / 'fake-pkg'
    nested.mkdir(parents=True)
    (nested / 'package.json').write_text('{"name":"fake"}', encoding='utf-8')

    rows = discover_workspace_npm_projects(root)
    assert [row['relativeDir'] for row in rows] == ['.']


def test_format_report_lists_relative_project_dir_hint(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / 'package.json').write_text('{"name":"demo","scripts":{"test":"vitest"}}', encoding='utf-8')
    rows = discover_workspace_npm_projects(root)
    text = format_npm_discovery_report(workspace_label=str(root), projects=rows)
    assert 'relative_project_dir' in text
    assert '`test`' in text
    assert 'demo@' not in text or 'demo' in text


@pytest.mark.asyncio
async def test_discover_tool_requires_session() -> None:
    from nemo_backend.node_project_discovery import discover_npm_projects_tool

    out = await discover_npm_projects_tool.ainvoke({})
    assert 'no active session' in out
