"""Seed ``.clara/checks.json`` with check commands the workspace seems to have, all turned off.

The user turns on the ones they want; nothing here runs a command.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from clara_coder_backend.verify.checks_config import workspace_checks_path
from clara_coder_backend.workspace.meta import migrate_legacy_workspace_meta_dir

__all__ = ['ensure_workspace_checks_file', 'suggest_workspace_checks']

logger = logging.getLogger('clara.verify.checks')

_MAX_SUGGESTIONS = 8
#: package.json scripts worth offering, in the order they should run (cheapest first).
_NPM_SCRIPTS = ('typecheck', 'type-check', 'lint', 'test', 'build')
_SLOW_TIMEOUT_SEC = 300
_EXAMPLE = {
    'name': 'example',
    'command': 'echo replace this with a test, lint or build command',
    'cwd': '',
    'paths': ['src/**'],
    'timeoutSeconds': 120,
    'enabled': False,
}


def _entry(name: str, command: str, *, cwd: str = '', paths: list[str] | None = None, slow: bool = False) -> dict[str, Any]:
    return {
        'name': name,
        'command': command,
        'cwd': cwd,
        'paths': paths or [],
        'timeoutSeconds': _SLOW_TIMEOUT_SEC if slow else 120,
        'enabled': False,
    }


def _npm_suggestions(workspace_root: Path) -> list[dict[str, Any]]:
    from clara_coder_backend.workspace.npm_projects import discover_workspace_npm_projects

    out: list[dict[str, Any]] = []
    for project in discover_workspace_npm_projects(workspace_root, max_depth=3, max_projects=4):
        rel = str(project.get('relativeDir') or '.')
        cwd = '' if rel == '.' else rel
        manager = str(project.get('packageManager') or 'npm')
        scripts = set(project.get('scripts') or ())
        for script in _NPM_SCRIPTS:
            if script not in scripts:
                continue
            name = f'{script} ({cwd})' if cwd else script
            paths = [f'{cwd}/**'] if cwd else []
            out.append(_entry(name, f'{manager} run {script}', cwd=cwd, paths=paths, slow=script in ('test', 'build')))
    return out


def _python_suggestions(workspace_root: Path) -> list[dict[str, Any]]:
    from clara_coder_backend.runtime.python_env import looks_like_pytest_project

    for cwd in ('', 'python'):
        if looks_like_pytest_project(workspace_root / cwd if cwd else workspace_root):
            paths = [f'{cwd}/**/*.py'] if cwd else ['**/*.py']
            return [_entry('pytest', 'python -m pytest -q', cwd=cwd, paths=paths, slow=True)]
    return []


def _rust_suggestions(workspace_root: Path) -> list[dict[str, Any]]:
    if not (workspace_root / 'Cargo.toml').is_file():
        return []
    paths = ['**/*.rs', '**/Cargo.toml']
    return [
        _entry('cargo check', 'cargo check', paths=paths, slow=True),
        _entry('cargo test', 'cargo test', paths=paths, slow=True),
    ]


def suggest_workspace_checks(workspace_root: Path) -> list[dict[str, Any]]:
    """Disabled ``checks`` entries for the commands this workspace seems to have."""

    suggestions: list[dict[str, Any]] = []
    for finder in (_npm_suggestions, _python_suggestions, _rust_suggestions):
        try:
            suggestions.extend(finder(workspace_root))
        except Exception:
            logger.warning('check suggestions failed finder=%s', finder.__name__, exc_info=True)
    return suggestions[:_MAX_SUGGESTIONS]


def ensure_workspace_checks_file(workspace_root: Path) -> tuple[Path, bool]:
    """Create ``.clara/checks.json`` when it is missing. Returns the path and whether it was created."""

    migrate_legacy_workspace_meta_dir(workspace_root)
    path = workspace_checks_path(workspace_root)
    if path.is_file():
        return path, False
    checks = suggest_workspace_checks(workspace_root) or [dict(_EXAMPLE)]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'version': 1, 'checks': checks}, indent=2) + '\n', encoding='utf-8')
    logger.info('checks file created path=%s suggestions=%d', path, len(checks))
    return path, True
