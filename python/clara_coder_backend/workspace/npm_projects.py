"""Discover npm/pnpm/yarn projects under a workspace (session attach hints)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from clara_coder_backend.workspace.npm_detection import (
    has_nonempty_node_modules,
    has_typescript_tooling,
    package_json_declares_typescript,
)

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
    'describe_npm_project',
    'detect_package_manager',
    'discover_workspace_npm_projects',
    'resolve_local_ng_executable',
]


def detect_package_manager(project_dir: Path) -> str:
    """Return ``npm``, ``pnpm``, or ``yarn`` based on lockfiles (``package.json`` directory)."""

    if (project_dir / 'pnpm-lock.yaml').is_file():
        return 'pnpm'
    if (project_dir / 'yarn.lock').is_file():
        return 'yarn'
    return 'npm'


def resolve_local_ng_executable(project_dir: Path) -> Path | None:
    """Return ``node_modules/.bin/ng`` (or Windows variants) if it exists as a file."""

    bindir = project_dir / 'node_modules' / '.bin'
    if sys.platform.startswith('win'):
        for name in ('ng.cmd', 'ng', 'ng.ps1'):
            candidate = bindir / name
            if candidate.is_file():
                return candidate
        return None
    candidate = bindir / 'ng'
    if candidate.is_file():
        return candidate
    return None


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
        'nodeModulesInstalled': has_nonempty_node_modules(project_dir),
        'scripts': script_names,
        'dependencyCounts': _dependency_counts(data),
        'workspaces': _workspaces_summary(data),
        'engines': engine_summary,
        'typescriptDeclared': package_json_declares_typescript(project_dir),
        'typescriptInstalled': has_typescript_tooling(project_dir),
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
