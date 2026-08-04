"""Install CPU PyTorch + Kokoro TTS into the app runtime venv."""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from clara_coder_backend.runtime.deps.paths import (
    get_runtime_python_dir,
    requirements_kokoro_pypi,
    venv_python,
)
from clara_coder_backend.runtime.deps.progress import PROGRESS
from clara_coder_backend.runtime.deps.providers import python_runtime as python_runtime_provider

logger = logging.getLogger('clara.runtime.deps.kokoro')

DEP_ID = 'kokoro'
SIZE_HINT = '~1–2 GB (CPU PyTorch + Kokoro)'
MARKER_NAME = '.clara-kokoro-ready'


def _marker_path() -> Path:
    return get_runtime_python_dir() / MARKER_NAME


def status() -> dict:
    py = venv_python()
    marker = _marker_path()
    version = marker.read_text(encoding='utf-8').strip() if marker.is_file() else None
    if py and version:
        try:
            subprocess.run(
                [str(py), '-c', 'import kokoro, torch'],
                check=True,
                capture_output=True,
                timeout=60,
            )
            return {
                'id': DEP_ID,
                'label': 'Kokoro TTS',
                'description': 'Local neural TTS (CPU PyTorch + kokoro).',
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
                'label': 'Kokoro TTS',
                'description': 'Local neural TTS (CPU PyTorch + kokoro).',
                'version': version,
                'state': 'error',
                'path': str(py),
                'sizeHint': SIZE_HINT,
                'canDelete': True,
                'error': f'Kokoro marker present but import failed: {exc}',
            }
    return {
        'id': DEP_ID,
        'label': 'Kokoro TTS',
        'description': 'Local neural TTS (CPU PyTorch + kokoro).',
        'version': None,
        'state': 'missing',
        'path': None,
        'sizeHint': SIZE_HINT,
        'canDelete': True,
        'error': None,
    }


def install(*, force: bool = False) -> dict:
    logger.info('install kokoro force=%s', force)
    # Ensure runtime venv exists first.
    rt = python_runtime_provider.status()
    if rt['state'] != 'installed':
        PROGRESS.emit(DEP_ID, 'installing', message='Preparing Python runtime…')
        python_runtime_provider.install(force=False)

    py = venv_python()
    if not py:
        raise RuntimeError('Python runtime venv is missing; install Python runtime first.')

    if not force and _marker_path().is_file():
        st = status()
        if st['state'] == 'installed':
            logger.info('kokoro already installed path=%s version=%s', st.get('path'), st.get('version'))
            PROGRESS.emit(DEP_ID, 'done', message='Already installed')
            return st

    PROGRESS.emit(DEP_ID, 'installing', message='Installing CPU PyTorch…')
    torch = subprocess.run(
        [
            str(py),
            '-m',
            'pip',
            'install',
            'torch',
            '--index-url',
            'https://download.pytorch.org/whl/cpu',
        ],
        capture_output=True,
        text=True,
    )
    if torch.returncode != 0:
        raise RuntimeError(f'torch install failed:\n{torch.stderr or torch.stdout}')

    req = requirements_kokoro_pypi()
    PROGRESS.emit(DEP_ID, 'installing', message='Installing Kokoro…')
    if req.is_file():
        kokoro = subprocess.run(
            [str(py), '-m', 'pip', 'install', '-r', str(req)],
            capture_output=True,
            text=True,
        )
    else:
        kokoro = subprocess.run(
            [str(py), '-m', 'pip', 'install', 'kokoro>=0.7.11,<0.10'],
            capture_output=True,
            text=True,
        )
    if kokoro.returncode != 0:
        # GitHub fallback (Python 3.13+)
        PROGRESS.emit(DEP_ID, 'installing', message='Kokoro PyPI failed; trying GitHub…')
        for args in (
            ['spacy>=3.8.14'],
            ['git+https://github.com/hexgrad/misaki.git'],
            ['git+https://github.com/hexgrad/kokoro.git'],
        ):
            r = subprocess.run(
                [str(py), '-m', 'pip', 'install', *args],
                capture_output=True,
                text=True,
            )
            if r.returncode != 0:
                raise RuntimeError(f'Kokoro install failed:\n{r.stderr or r.stdout}')
    else:
        pass

    _marker_path().write_text('kokoro\n', encoding='utf-8')
    logger.info('kokoro ready path=%s', py)
    PROGRESS.emit(DEP_ID, 'done', message='Kokoro TTS ready')
    return status()


def delete() -> dict:
    py = venv_python()
    marker = _marker_path()
    logger.info('delete kokoro path=%s', py)
    if py and py.is_file():
        PROGRESS.emit(DEP_ID, 'installing', message='Uninstalling Kokoro packages…')
        subprocess.run(
            [str(py), '-m', 'pip', 'uninstall', '-y', 'kokoro', 'misaki'],
            capture_output=True,
            text=True,
        )
        # Leave torch installed — shared; user can reinstall kokoro later.
    if marker.exists():
        marker.unlink(missing_ok=True)
    PROGRESS.emit(DEP_ID, 'done', message='Kokoro removed')
    return status()
