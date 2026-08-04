"""Ensure app-managed Python venv + core requirements.txt."""

from __future__ import annotations

import logging
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

logger = logging.getLogger('clara.runtime.deps.python_runtime')

DEP_ID = 'python-runtime'
SIZE_HINT = '~150 MB (venv + core packages)'


def _base_python() -> str:
    return sys.executable


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
    PROGRESS.emit(DEP_ID, 'installing', message='Creating virtualenv…')
    venv = get_runtime_python_dir()
    if force and venv.exists():
        shutil.rmtree(venv, ignore_errors=True)

    existing = venv_python(venv)
    if existing and not force and read_ready_marker(venv):
        st = status()
        if st['state'] == 'installed':
            PROGRESS.emit(DEP_ID, 'done', message='Already installed')
            return st

    venv.mkdir(parents=True, exist_ok=True)
    base = _base_python()
    r = subprocess.run([base, '-m', 'venv', str(venv)], capture_output=True, text=True)
    if r.returncode != 0:
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
        raise RuntimeError(f'pip install failed:\n{pip.stderr or pip.stdout}')

    ver = f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}'
    write_ready_marker(venv, ver)
    PROGRESS.emit(DEP_ID, 'done', message='Python runtime ready')
    return status()


def delete() -> dict:
    venv = get_runtime_python_dir()
    if venv.exists():
        shutil.rmtree(venv, ignore_errors=True)
    PROGRESS.emit(DEP_ID, 'done', message='Python runtime removed')
    return status()
