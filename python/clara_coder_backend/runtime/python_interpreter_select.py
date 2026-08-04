"""Discover workspace Python interpreters and apply selection for LSP / tools."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

from clara_coder_backend.domain import SessionState
from clara_coder_backend.runtime.python_env import deduce_venv_root_from_interpreter
from clara_coder_backend.runtime.deps.paths import get_runtime_python_dir, venv_python
from clara_coder_backend.runtime.python_env import (
    activate_process_workspace_python_env,
    resolve_python_workspace_root,
)

logger = logging.getLogger('clara.python.interpreter')

# Keep in sync with ``src/shared/python-interpreter-ids.ts``.
RUNTIME_VENV_INTERPRETER_ID = 'runtime-venv'
APP_BACKEND_INTERPRETER_ID = 'app-backend'

__all__ = [
    'APP_BACKEND_INTERPRETER_ID',
    'RUNTIME_VENV_INTERPRETER_ID',
    'apply_default_workspace_python_interpreter',
    'apply_python_interpreter_entry',
    'discover_workspace_python_interpreters',
    'find_interpreter_entry_by_id',
    'resolve_default_interpreter_entry',
]


def _venv_python_executable(venv_root: Path) -> Path:
    if sys.platform.startswith('win'):
        return venv_root / 'Scripts' / 'python.exe'
    return venv_root / 'bin' / 'python'


def discover_workspace_python_interpreters(workspace_root: Path) -> list[dict[str, Any]]:
    """Return interpreter choices for a workspace folder (stable ``id`` strings).

    Order: Clara runtime venv (when installed) → app backend → workspace venvs.
    """

    root = Path(workspace_root).resolve()
    rows: list[dict[str, Any]] = []

    runtime_exe = venv_python(get_runtime_python_dir())
    runtime_resolved: Path | None = None
    if runtime_exe is not None:
        runtime_resolved = runtime_exe.resolve()
        runtime_venv = get_runtime_python_dir().resolve()
        rows.append(
            {
                'id': RUNTIME_VENV_INTERPRETER_ID,
                'label': 'Clara runtime (app)',
                'pythonExecutable': str(runtime_resolved),
                'venvPath': str(runtime_venv) if runtime_venv.is_dir() else '',
            }
        )

    backend_exe = Path(sys.executable).resolve()
    # Avoid a duplicate row when the sidecar already runs from the runtime venv.
    if runtime_resolved is None or backend_exe != runtime_resolved:
        back_venv = deduce_venv_root_from_interpreter(backend_exe)
        rows.append(
            {
                'id': APP_BACKEND_INTERPRETER_ID,
                'label': 'App backend (current process)',
                'pythonExecutable': str(backend_exe),
                'venvPath': str(back_venv.resolve()) if back_venv is not None else '',
            }
        )

    candidates: list[tuple[str, str, Path]] = [
        ('dot-venv', '.venv', root / '.venv'),
        ('venv', 'venv', root / 'venv'),
        ('python-dot-venv', 'python/.venv', root / 'python' / '.venv'),
    ]
    for sid, label, vdir in candidates:
        exe = _venv_python_executable(vdir)
        if not exe.is_file():
            continue
        rows.append(
            {
                'id': sid,
                'label': f'{label} (workspace)',
                'pythonExecutable': str(exe.resolve()),
                'venvPath': str(vdir.resolve()),
            }
        )

    return rows


def find_interpreter_entry_by_id(workspace_root: Path, interpreter_id: str) -> dict[str, Any] | None:
    """Lookup a discovery row by ``id``."""

    want = (interpreter_id or '').strip()
    if not want:
        return None
    for row in discover_workspace_python_interpreters(workspace_root):
        if row.get('id') == want:
            return row
    return None


def resolve_default_interpreter_entry(workspace_root: Path) -> dict[str, Any] | None:
    """Prefer Clara runtime venv, then app-backend, then first discovered row."""

    rows = discover_workspace_python_interpreters(workspace_root)
    for prefer in (RUNTIME_VENV_INTERPRETER_ID, APP_BACKEND_INTERPRETER_ID):
        for row in rows:
            if row.get('id') == prefer:
                return row
    return rows[0] if rows else None


def apply_python_interpreter_entry(session: SessionState, workspace_root: Path, entry: dict[str, Any]) -> None:
    """Write session Python env fields from a discovery row (see :func:`discover_workspace_python_interpreters`)."""

    root = Path(workspace_root).resolve()
    project_root, label = resolve_python_workspace_root(root, allow_workspace_root_fallback=True)
    if project_root is None:
        project_root = root
        label = '.'
    exe_raw = entry.get('pythonExecutable')
    if not exe_raw:
        raise ValueError('interpreter entry missing pythonExecutable')
    exe = Path(str(exe_raw)).resolve()
    if not exe.is_file():
        raise ValueError(f'Python executable not found: {exe}')

    vp_raw = str(entry.get('venvPath') or '').strip()
    if vp_raw:
        venv_path = Path(vp_raw).resolve()
        session.python_workspace_venv_path = str(venv_path) if venv_path.is_dir() else ''
    else:
        inferred = deduce_venv_root_from_interpreter(exe)
        session.python_workspace_venv_path = str(inferred.resolve()) if inferred is not None else ''

    session.python_workspace_root = str(project_root.resolve())
    session.python_workspace_root_label = label
    session.python_workspace_python_executable = str(exe)
    session.python_workspace_bin_path = str(exe.parent)
    session.python_interpreter_choice_id = str(entry.get('id') or '')

    if session.python_workspace_venv_path:
        try:
            activate_process_workspace_python_env(Path(session.python_workspace_venv_path))
        except Exception:
            logger.debug('activate_process_workspace_python_env failed', exc_info=True)


def apply_default_workspace_python_interpreter(session: SessionState, workspace_root: Path) -> dict[str, Any] | None:
    """Apply the app default interpreter (runtime venv when present). Returns the entry or None."""

    entry = resolve_default_interpreter_entry(workspace_root)
    if entry is None:
        return None
    apply_python_interpreter_entry(session, workspace_root, entry)
    logger.info(
        'applied default python interpreter id=%s exe=%s',
        entry.get('id'),
        entry.get('pythonExecutable'),
    )
    return entry
