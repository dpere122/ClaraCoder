"""Discover npm/pnpm/yarn projects under a workspace for dependency management."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from langchain_core.tools import tool

from nemo_backend.tools.angular_cli import resolve_local_ng_executable
from nemo_backend.lsp.typescript_project_root import (
    _has_nonempty_node_modules,
    _has_typescript_tooling,
    _package_json_declares_typescript,
)
from nemo_backend.tools.node_deps import (
    _resolve_project_dir,
    _workspace_root,
    detect_package_manager,
)
from nemo_backend.state import current_session_id, get_session
from nemo_backend.tools.workspace import truncate_text_head_tail

DISCOVER_NPM_PROJECTS_NAME = 'discover_npm_projects'

_MAX_OUTPUT_CHARS = 80_000
_MAX_PROJECTS = 64
_DEFAULT_MAX_DEPTH = 16

_SKIP_WALK_DIRS = frozenset(
    {
        'node_modules',
        '.git',
        'dist',
        'build',
        '.angular',
        'coverage',
        '__pycache__',
        '.venv',
        'venv',
    }
)

_LOCKFILE_NAMES = ('package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json')

__all__ = [
    'DISCOVER_NPM_PROJECTS_NAME',
    'discover_npm_projects_tool',
    'discover_workspace_npm_projects',
    'format_npm_discovery_report',
]


def _relative_dir(workspace_root: Path, project_dir: Path) -> str:
    if project_dir.resolve() == workspace_root.resolve():
        return '.'
    return project_dir.resolve().relative_to(workspace_root.resolve()).as_posix()


def _dependency_counts(data: dict[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for key in ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
        block = data.get(key)
        if isinstance(block, dict):
            out[key] = len(block)
    return out


def _workspaces_summary(data: dict[str, Any]) -> dict[str, Any] | None:
    workspaces = data.get('workspaces')
    if isinstance(workspaces, list):
        patterns = [str(x) for x in workspaces if str(x).strip()][:16]
        return {'kind': 'array', 'count': len(workspaces), 'patterns': patterns}
    if isinstance(workspaces, dict):
        packages = workspaces.get('packages')
        count = len(packages) if isinstance(packages, list) else 0
        return {'kind': 'object', 'count': count}
    return None


def _present_lockfiles(project_dir: Path) -> list[str]:
    return [name for name in _LOCKFILE_NAMES if (project_dir / name).is_file()]


def describe_npm_project(project_dir: Path, *, relative_dir: str) -> dict[str, Any] | None:
    """Build one discovery row for a directory that contains ``package.json``."""

    pkg_path = project_dir / 'package.json'
    if not pkg_path.is_file():
        return None
    try:
        data = json.loads(pkg_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}

    scripts = data.get('scripts')
    script_names = sorted(scripts.keys()) if isinstance(scripts, dict) else []

    engines = data.get('engines')
    engine_summary: dict[str, str] = {}
    if isinstance(engines, dict):
        for key in ('node', 'npm', 'pnpm', 'yarn'):
            val = engines.get(key)
            if isinstance(val, str) and val.strip():
                engine_summary[key] = val.strip()

    return {
        'relativeDir': relative_dir,
        'name': str(data.get('name') or '').strip() or '(unnamed)',
        'version': str(data.get('version') or '').strip(),
        'private': bool(data.get('private')),
        'packageManager': detect_package_manager(project_dir),
        'lockfiles': _present_lockfiles(project_dir),
        'nodeModulesInstalled': _has_nonempty_node_modules(project_dir),
        'scripts': script_names,
        'dependencyCounts': _dependency_counts(data),
        'workspaces': _workspaces_summary(data),
        'engines': engine_summary,
        'typescriptDeclared': _package_json_declares_typescript(project_dir),
        'typescriptInstalled': _has_typescript_tooling(project_dir),
        'angularCliInstalled': resolve_local_ng_executable(project_dir) is not None,
    }


def discover_workspace_npm_projects(
    workspace_root: Path,
    *,
    scope_dir: Path | None = None,
    max_depth: int = _DEFAULT_MAX_DEPTH,
    max_projects: int = _MAX_PROJECTS,
) -> list[dict[str, Any]]:
    """Find Node package roots under ``workspace_root`` (optionally limited to ``scope_dir`` subtree)."""

    workspace_root = Path(workspace_root).resolve()
    walk_root = Path(scope_dir).resolve() if scope_dir is not None else workspace_root
    try:
        walk_root.relative_to(workspace_root)
    except ValueError:
        return []

    found: list[dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(walk_root):
        d = Path(dirpath)
        depth = 0 if d == walk_root else len(d.relative_to(walk_root).parts)
        if depth > max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = [x for x in dirnames if x not in _SKIP_WALK_DIRS]
        if 'package.json' not in filenames:
            continue
        rel = _relative_dir(workspace_root, d)
        row = describe_npm_project(d, relative_dir=rel)
        if row is not None:
            found.append(row)
        if len(found) >= max_projects:
            break

    found.sort(key=lambda row: (len(str(row.get('relativeDir') or '')), str(row.get('relativeDir') or '')))
    return found


def _format_dep_counts(counts: dict[str, int]) -> str:
    if not counts:
        return 'none listed'
    labels = {
        'dependencies': 'prod',
        'devDependencies': 'dev',
        'peerDependencies': 'peer',
        'optionalDependencies': 'optional',
    }
    parts = [f'{counts[key]} {labels[key]}' for key in labels if counts.get(key)]
    return ', '.join(parts) if parts else 'none listed'


def format_npm_discovery_report(
    *,
    workspace_label: str,
    projects: list[dict[str, Any]],
    scope_label: str | None = None,
    truncated: bool = False,
) -> str:
    scope_line = f'- Scope: `{scope_label}`\n' if scope_label and scope_label != '.' else ''
    if not projects:
        body = (
            'npm workspace discovery:\n'
            f'- Workspace: `{workspace_label}`\n'
            f'{scope_line}'
            '- Projects found: 0\n\n'
            'No `package.json` files were found under this scope. '
            'Use `relative_project_dir` on npm tools only after a package root exists.'
        )
        return body

    lines = [
        f'npm workspace discovery ({len(projects)} project{"s" if len(projects) != 1 else ""}):',
        f'- Workspace: `{workspace_label}`',
    ]
    if scope_line:
        lines.append(scope_line.rstrip('\n'))
    if truncated:
        lines.append('- Note: project list was truncated (too many `package.json` files).')
    lines.append('')
    lines.append(
        'Use `relative_project_dir` on `install_npm_packages`, `npm_install_project`, `run_npm_script`, '
        'and `angular_cli_tool` matching the directory below (`.` = workspace root).'
    )
    lines.append('')

    for index, row in enumerate(projects, start=1):
        rel = str(row.get('relativeDir') or '.')
        name = str(row.get('name') or '(unnamed)')
        version = str(row.get('version') or '').strip()
        version_suffix = f'@{version}' if version else ''
        private = ' (private)' if row.get('private') else ''
        pm = str(row.get('packageManager') or 'npm')
        lockfiles = row.get('lockfiles') if isinstance(row.get('lockfiles'), list) else []
        lock_text = ', '.join(f'`{x}`' for x in lockfiles) if lockfiles else 'none'
        nm = 'installed' if row.get('nodeModulesInstalled') else 'missing or empty'
        scripts = row.get('scripts') if isinstance(row.get('scripts'), list) else []
        if scripts:
            preview = ', '.join(f'`{s}`' for s in scripts[:20])
            if len(scripts) > 20:
                preview += f' … (+{len(scripts) - 20} more)'
        else:
            preview = '(none)'
        dep_counts = row.get('dependencyCounts') if isinstance(row.get('dependencyCounts'), dict) else {}
        ts_decl = bool(row.get('typescriptDeclared'))
        ts_inst = bool(row.get('typescriptInstalled'))
        if ts_inst:
            ts_line = 'local `typescript` / `tsc` in node_modules'
        elif ts_decl:
            ts_line = 'declared in package.json (node_modules may be incomplete)'
        else:
            ts_line = 'not detected'
        ng = 'local `node_modules/.bin/ng`' if row.get('angularCliInstalled') else 'not installed locally'

        lines.append(f'{index}. `{rel}` — {name}{version_suffix}{private}')
        lines.append(f'   - Package manager: `{pm}`; lockfiles: {lock_text}')
        lines.append(f'   - node_modules: {nm}')
        lines.append(f'   - Scripts: {preview}')
        lines.append(f'   - Dependencies: {_format_dep_counts(dep_counts)}')
        ws = row.get('workspaces')
        if isinstance(ws, dict) and ws.get('count'):
            kind = ws.get('kind', 'workspaces')
            count = ws.get('count')
            patterns = ws.get('patterns')
            if isinstance(patterns, list) and patterns:
                pat = ', '.join(f'`{p}`' for p in patterns[:8])
                suffix = ' …' if len(patterns) > 8 else ''
                lines.append(f'   - Workspaces ({kind}, {count}): {pat}{suffix}')
            else:
                lines.append(f'   - Workspaces ({kind}): {count} pattern(s)')
        engines = row.get('engines') if isinstance(row.get('engines'), dict) else {}
        if engines:
            eng = '; '.join(f'{k} {v}' for k, v in engines.items())
            lines.append(f'   - Engines: {eng}')
        lines.append(f'   - TypeScript: {ts_line}')
        lines.append(f'   - Angular CLI: {ng}')
        lines.append('')

    body = '\n'.join(lines).rstrip() + '\n'
    if len(body) <= _MAX_OUTPUT_CHARS:
        return body
    return truncate_text_head_tail(body, _MAX_OUTPUT_CHARS)


@tool(DISCOVER_NPM_PROJECTS_NAME)
async def discover_npm_projects_tool(relative_project_dir: str = '') -> str:
    """Scan the workspace for npm/pnpm/yarn projects before changing dependencies.

    Returns every ``package.json`` root under the workspace (or under ``relative_project_dir`` when set):
    package manager, lockfiles, whether ``node_modules`` is populated, script names, dependency counts,
  workspace layout, engines, and TypeScript / Angular CLI hints. Read-only; does not run install or scripts.
    Use the reported ``relative_project_dir`` values with ``install_npm_packages``, ``npm_install_project``,
    ``run_npm_script``, and ``angular_cli_tool``.
    """

    sid = (current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    session = get_session(sid)

    workspace_root, ws_label = _workspace_root(session)
    if workspace_root is None:
        return ws_label

    scope_dir: Path | None = None
    scope_label: str | None = None
    cleaned = (relative_project_dir or '').strip().replace('\\', '/').strip('/')
    if cleaned:
        scope_dir, err, scope_label = _resolve_project_dir(workspace_root, relative_project_dir)
        if err:
            return err
        assert scope_dir is not None

    projects = discover_workspace_npm_projects(
        workspace_root,
        scope_dir=scope_dir,
        max_depth=_DEFAULT_MAX_DEPTH,
        max_projects=_MAX_PROJECTS,
    )
    truncated = len(projects) >= _MAX_PROJECTS
    return format_npm_discovery_report(
        workspace_label=ws_label,
        projects=projects,
        scope_label=scope_label,
        truncated=truncated,
    )


def node_project_discovery_tools() -> tuple[list[object], dict[str, object]]:
    tools: list[object] = [discover_npm_projects_tool]
    return tools, {t.name: t for t in tools}
