"""Ensure app-managed Python venv + core requirements.txt."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from clara_coder_backend.runtime.deps.download import read_ready_marker, write_ready_marker
from clara_coder_backend.runtime.deps.paths import (
    get_runtime_python_dir,
    requirements_txt,
    venv_python,
)
from clara_coder_backend.runtime.deps.progress import PROGRESS
from clara_coder_backend.session.config import env_clara

logger = logging.getLogger('clara.runtime.deps.python_runtime')

DEP_ID = 'python-runtime'
SIZE_HINT = '~150 MB (venv + core packages)'


def _path_is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


def _interpreter_version(python_exe: str) -> str:
    """Return ``major.minor.micro`` for ``python_exe``, falling back to this process."""
    try:
        r = subprocess.run(
            [
                python_exe,
                '-c',
                'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")',
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        ver = (r.stdout or '').strip()
        if r.returncode == 0 and ver:
            return ver
    except (OSError, subprocess.TimeoutExpired):
        pass
    return f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}'


def _base_python(target_venv: Path) -> str:
    """Return an interpreter that can create ``target_venv``.

    Must not be the runtime venv itself — reinstall deletes that directory while the
    FastAPI sidecar may still be running from ``…/python-venv/bin/python``.
    """
    target = target_venv.resolve()
    candidates: list[Path] = []

    # CLARA_PYTHON via env_clara (also accepts legacy NEMO_PYTHON). Bare PYTHON is
    # a standard interpreter hint and is not namespaced — read it directly.
    for raw in (env_clara('CLARA_PYTHON', ''), os.getenv('PYTHON') or ''):
        raw = raw.strip()
        if raw:
            candidates.append(Path(raw))

    # Real base behind a venv process (portable/system) — survives deleting the venv.
    base_exe = getattr(sys, '_base_executable', None) or ''
    if base_exe:
        candidates.append(Path(str(base_exe)))

    candidates.append(Path(sys.executable))

    for name in ('python3', 'python'):
        which = shutil.which(name)
        if which:
            candidates.append(Path(which))

    seen: set[str] = set()
    for cand in candidates:
        try:
            resolved = cand.resolve()
        except OSError:
            continue
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        if not resolved.is_file():
            continue
        if _path_is_under(resolved, target):
            continue
        return str(resolved)

    raise RuntimeError(
        'No durable Python interpreter available to create the runtime venv. '
        'Install Python 3 or set CLARA_PYTHON to a system/portable interpreter.'
    )


def status() -> dict:
    venv = get_runtime_python_dir()
    py = venv_python(venv)
    version = read_ready_marker(venv)
    if py and version:
        # Verify a core import
        try:
            subprocess.run(
                [str(py), '-c', 'import fastapi, uvicorn'],
                check=True,
                capture_output=True,
                timeout=30,
            )
            return {
                'id': DEP_ID,
                'label': 'Python runtime',
                'description': 'App-managed virtualenv with Clara backend packages.',
                'version': version,
                'state': 'installed',
                'path': str(py),
                'sizeHint': SIZE_HINT,
                'canDelete': True,
                'error': None,
            }
        except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired) as exc:
            return {
                'id': DEP_ID,
                'label': 'Python runtime',
                'description': 'App-managed virtualenv with Clara backend packages.',
                'version': version,
                'state': 'error',
                'path': str(py),
                'sizeHint': SIZE_HINT,
                'canDelete': True,
                'error': f'Venv present but core packages missing: {exc}',
            }
    return {
        'id': DEP_ID,
        'label': 'Python runtime',
        'description': 'App-managed virtualenv with Clara backend packages.',
        'version': None,
        'state': 'missing',
        'path': None,
        'sizeHint': SIZE_HINT,
        'canDelete': True,
        'error': None,
    }


def install(*, force: bool = False) -> dict:
    logger.info('install python-runtime force=%s', force)
    PROGRESS.emit(DEP_ID, 'installing', message='Creating virtualenv…')
    venv = get_runtime_python_dir()
    # Resolve before force-delete: sidecar often runs from this venv.
    base = _base_python(venv)
    logger.info('python-runtime base interpreter=%s', base)

    if force and venv.exists():
        shutil.rmtree(venv, ignore_errors=True)

    existing = venv_python(venv)
    if existing and not force and read_ready_marker(venv):
        st = status()
        if st['state'] == 'installed':
            logger.info('python-runtime already installed path=%s version=%s', st.get('path'), st.get('version'))
            PROGRESS.emit(DEP_ID, 'done', message='Already installed')
            return st

    venv.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([base, '-m', 'venv', str(venv)], capture_output=True, text=True)
    if r.returncode != 0:
        logger.error('python-runtime venv create failed: %s', r.stderr or r.stdout)
        raise RuntimeError(f'Failed to create venv: {r.stderr or r.stdout}')

    py = venv_python(venv)
    if not py:
        raise RuntimeError(f'Venv created but python missing under {venv}')

    PROGRESS.emit(DEP_ID, 'installing', message='Bootstrapping pip…')
    subprocess.run([str(py), '-m', 'ensurepip', '--upgrade'], check=False, capture_output=True)

    req = requirements_txt()
    if not req.is_file():
        raise RuntimeError(f'Missing requirements file: {req}')

    PROGRESS.emit(DEP_ID, 'installing', message='Installing core packages…')
    pip = subprocess.run(
        [str(py), '-m', 'pip', 'install', '-r', str(req)],
        capture_output=True,
        text=True,
    )
    if pip.returncode != 0:
        logger.error('python-runtime pip install failed')
        raise RuntimeError(f'pip install failed:\n{pip.stderr or pip.stdout}')

    # Version of the venv interpreter (matches ``base``), not the possibly-different sidecar.
    ver = _interpreter_version(str(py))
    write_ready_marker(venv, ver)
    logger.info('python-runtime ready path=%s version=%s', py, ver)
    PROGRESS.emit(DEP_ID, 'done', message='Python runtime ready')
    return status()


def delete() -> dict:
    venv = get_runtime_python_dir()
    logger.info('delete python-runtime path=%s', venv)
    if venv.exists():
        shutil.rmtree(venv, ignore_errors=True)
    PROGRESS.emit(DEP_ID, 'done', message='Python runtime removed')
    return status()
