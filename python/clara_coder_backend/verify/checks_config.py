"""The workspace's check commands (``.clara/checks.json``), written by the user.

```json
{
  "version": 1,
  "checks": [
    {"name": "typecheck", "command": "npx tsc -p ./ --noEmit", "paths": ["src/**/*.ts"]},
    {"name": "tests", "command": "python -m pytest -q", "cwd": "python", "timeoutSeconds": 300, "enabled": false}
  ]
}
```

``cwd`` is a workspace-relative folder (default: the workspace root). ``paths`` are globs over
workspace-relative paths (``*`` within a folder, ``**`` across folders); a check with ``paths`` runs only
when the turn touched a matching file. ``enabled`` defaults to true.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from clara_coder_backend.workspace.meta import CHECKS_FILENAME, CHECKS_RELATIVE_PATH, WORKSPACE_META_DIR

__all__ = [
    'CHECK_TIMEOUT_DEFAULT_SEC',
    'MAX_ENABLED_CHECKS',
    'WorkspaceCheck',
    'WorkspaceChecks',
    'check_applies',
    'load_workspace_checks',
    'workspace_checks_path',
]

logger = logging.getLogger('clara.verify.checks')

#: Enabled checks past this many are ignored: they all run, one after another, when a turn ends.
MAX_ENABLED_CHECKS = 6
CHECK_TIMEOUT_DEFAULT_SEC = 120
CHECK_TIMEOUT_MIN_SEC = 5
CHECK_TIMEOUT_MAX_SEC = 600
_NAME_MAX_CHARS = 60
_MAX_PATH_GLOBS = 32


@dataclass(frozen=True)
class WorkspaceCheck:
    """One command whose exit code says whether the workspace is in a good state."""

    name: str
    command: str
    #: Workspace-relative POSIX folder to run in; empty for the workspace root.
    cwd: str = ''
    #: Globs over touched paths; empty runs the check after any edit.
    paths: tuple[str, ...] = ()
    timeout_seconds: int = CHECK_TIMEOUT_DEFAULT_SEC
    enabled: bool = True


@dataclass(frozen=True)
class WorkspaceChecks:
    """Validated ``.clara/checks.json``."""

    checks: tuple[WorkspaceCheck, ...] = ()
    #: Why entries were ignored, for the user (shown with the verification result).
    problems: tuple[str, ...] = ()

    @property
    def enabled(self) -> tuple[WorkspaceCheck, ...]:
        return tuple(check for check in self.checks if check.enabled)


def workspace_checks_path(workspace_root: Path) -> Path:
    return workspace_root / WORKSPACE_META_DIR / CHECKS_FILENAME


def _command_problem(command: str) -> str | None:
    """Why the harness will not run ``command`` on its own, or None."""
    from clara_coder_backend.runtime.subprocess_smoke import argv_implies_watch_mode
    from clara_coder_backend.tools.run_command import normalize_run_command_elevation, validate_run_command_text

    err = validate_run_command_text(command)
    if err:
        return err.removeprefix('Tool error: ').rstrip('.')
    if normalize_run_command_elevation(command)[1]:
        return 'checks cannot run elevated (`sudo`)'
    try:
        argv = shlex.split(command, posix=False)
    except ValueError:
        argv = command.split()
    if argv_implies_watch_mode(argv):
        return 'it starts a watch or dev-server process that never exits'
    return None


def _clean_cwd(value: Any) -> str | None:
    if value is None:
        return ''
    if not isinstance(value, str):
        return None
    cwd = value.strip().replace('\\', '/')
    while cwd.startswith('./'):
        cwd = cwd[2:]
    cwd = cwd.strip('/')
    if cwd in ('', '.'):
        return ''
    parts = cwd.split('/')
    if any(part in ('', '.', '..') for part in parts) or ':' in parts[0]:
        return None
    return cwd


def _clean_paths(value: Any) -> tuple[str, ...] | None:
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > _MAX_PATH_GLOBS:
        return None
    out = tuple(v.strip().replace('\\', '/').lstrip('/') for v in value if isinstance(v, str) and v.strip())
    return out if len(out) == len(value) else None


def _clean_timeout(value: Any) -> int | None:
    if value is None:
        return CHECK_TIMEOUT_DEFAULT_SEC
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(CHECK_TIMEOUT_MIN_SEC, min(CHECK_TIMEOUT_MAX_SEC, int(value)))


def _parse_check(index: int, raw: Any) -> tuple[WorkspaceCheck | None, str | None]:
    label = f'check {index}'
    if not isinstance(raw, dict):
        return None, f'{label}: must be an object'
    command = raw.get('command')
    if not isinstance(command, str) or not command.strip():
        return None, f'{label}: `command` is required'
    command = command.strip()
    raw_name = raw.get('name')
    name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else command
    name = name[:_NAME_MAX_CHARS]
    label = f'check `{name}`'
    enabled = raw.get('enabled', True)
    if not isinstance(enabled, bool):
        return None, f'{label}: `enabled` must be true or false'
    cwd = _clean_cwd(raw.get('cwd'))
    if cwd is None:
        return None, f'{label}: `cwd` must be a folder inside the workspace'
    paths = _clean_paths(raw.get('paths'))
    if paths is None:
        return None, f'{label}: `paths` must be a list of glob strings'
    timeout = _clean_timeout(raw.get('timeoutSeconds'))
    if timeout is None:
        return None, f'{label}: `timeoutSeconds` must be a number'
    if enabled:
        # A disabled entry (a suggestion the user has not turned on) is kept as written.
        problem = _command_problem(command)
        if problem:
            return None, f'{label}: {problem}'
    return WorkspaceCheck(name, command, cwd, paths, timeout, enabled), None


def load_workspace_checks(workspace_root: Path) -> WorkspaceChecks:
    """Parse ``.clara/checks.json``; a missing file is no checks, invalid entries are reported and skipped."""

    path = workspace_checks_path(workspace_root)
    if not path.is_file():
        return WorkspaceChecks()
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError) as exc:
        logger.warning('checks file unreadable path=%s err=%s', path, exc)
        return WorkspaceChecks(problems=(f'`{CHECKS_RELATIVE_PATH}` is not valid JSON ({exc})',))
    raw_checks = data.get('checks') if isinstance(data, dict) else None
    if not isinstance(raw_checks, list):
        return WorkspaceChecks(problems=(f'`{CHECKS_RELATIVE_PATH}` needs a `checks` list',))
    checks: list[WorkspaceCheck] = []
    problems: list[str] = []
    enabled = 0
    for index, raw in enumerate(raw_checks, start=1):
        check, problem = _parse_check(index, raw)
        if check is None:
            problems.append(problem or f'check {index}: invalid')
            continue
        if check.enabled:
            enabled += 1
            if enabled > MAX_ENABLED_CHECKS:
                problems.append(f'check `{check.name}`: skipped, at most {MAX_ENABLED_CHECKS} checks can be enabled')
                continue
        checks.append(check)
    for problem in problems:
        logger.warning('checks file: %s (%s)', problem, path)
    return WorkspaceChecks(tuple(checks), tuple(problems))


@lru_cache(maxsize=256)
def _glob_regex(pattern: str) -> re.Pattern[str]:
    """``*`` and ``?`` stay inside one folder; ``**`` crosses folders (``**/`` also matches no folder)."""
    out: list[str] = []
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if pattern.startswith('**/', i):
            out.append('(?:.*/)?')
            i += 3
        elif pattern.startswith('**', i):
            out.append('.*')
            i += 2
        elif ch == '*':
            out.append('[^/]*')
            i += 1
        elif ch == '?':
            out.append('[^/]')
            i += 1
        else:
            out.append(re.escape(ch))
            i += 1
    return re.compile(''.join(out), re.IGNORECASE if os.name == 'nt' else 0)


def check_applies(check: WorkspaceCheck, touched_paths: Iterable[str]) -> bool:
    """True when the check has no ``paths`` filter or one of its globs matches a touched path."""
    if not check.paths:
        return True
    regexes = [_glob_regex(pattern) for pattern in check.paths]
    return any(regex.fullmatch(path) for path in touched_paths for regex in regexes)
