"""Install faster-whisper (CPU CTranslate2) into the app runtime venv."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from pathlib import Path

from clara_coder_backend.config import DEFAULT_WHISPER_MODEL
from clara_coder_backend.runtime.deps.paths import (
    get_runtime_python_dir,
    requirements_whisper_pypi,
    venv_python,
    whisper_models_dir,
)
from clara_coder_backend.runtime.deps.progress import PROGRESS
from clara_coder_backend.runtime.deps.providers import python_runtime as python_runtime_provider

logger = logging.getLogger('clara.runtime.deps.whisper')

DEP_ID = 'whisper'
SIZE_HINT = '~80–1600 MB (CTranslate2 + chosen size)'
MARKER_NAME = '.clara-whisper-ready'
_DOWNLOAD_TIMEOUT_SEC = 1800
_PIP_TIMEOUT_SEC = 1800

# faster-whisper size aliases → Hub repo ids (subset shown in the UI).
WHISPER_SIZE_REPOS: dict[str, str] = {
    'tiny': 'Systran/faster-whisper-tiny',
    'base': 'Systran/faster-whisper-base',
    'small': 'Systran/faster-whisper-small',
    'medium': 'Systran/faster-whisper-medium',
    'distil-large-v3': 'Systran/faster-distil-whisper-large-v3',
    'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
}


def _marker_path() -> Path:
    return get_runtime_python_dir() / MARKER_NAME


def hub_cache_dirname(repo_id: str) -> str:
    """Hugging Face Hub cache folder for ``org/name`` (``models--org--name``)."""
    return 'models--' + repo_id.replace('/', '--')


def _hf_token() -> str:
    return (
        os.getenv('HF_TOKEN', '')
        or os.getenv('HUGGING_FACE_HUB_TOKEN', '')
        or os.getenv('HUGGINGFACE_HUB_TOKEN', '')
    ).strip()


def normalize_whisper_size(variant: str | None) -> str:
    size = (variant or DEFAULT_WHISPER_MODEL).strip() or DEFAULT_WHISPER_MODEL
    if size not in WHISPER_SIZE_REPOS:
        raise RuntimeError(
            f'Unsupported Whisper size {size!r}; expected one of {list(WHISPER_SIZE_REPOS)}'
        )
    return size


def size_is_downloaded(size: str, root: Path | None = None) -> bool:
    repo = WHISPER_SIZE_REPOS.get(size)
    if not repo:
        return False
    base = (root or whisper_models_dir()) / hub_cache_dirname(repo)
    snaps = base / 'snapshots'
    if not snaps.is_dir():
        return False
    # Prefer exists() over glob: on Windows, Hub ``model.bin`` is often a junction
    # that Path.glob skips. config.json is a regular file in a complete snapshot.
    try:
        entries = snaps.iterdir()
    except OSError:
        return False
    for snap in entries:
        if not snap.is_dir():
            continue
        if (snap / 'model.bin').exists() or (snap / 'config.json').exists():
            return True
    return False


def list_downloaded_models(root: Path | None = None) -> list[str]:
    models_root = root if root is not None else whisper_models_dir()
    return [size for size in WHISPER_SIZE_REPOS if size_is_downloaded(size, models_root)]


def _info(
    *,
    state: str,
    version: str | None = None,
    path: str | None = None,
    error: str | None = None,
) -> dict:
    return {
        'id': DEP_ID,
        'label': 'Whisper STT',
        'description': 'Local speech-to-text (faster-whisper, CPU CTranslate2).',
        'version': version,
        'state': state,
        'path': path,
        'sizeHint': SIZE_HINT,
        'canDelete': True,
        'error': error,
        'downloadedModels': list_downloaded_models(),
    }


def status() -> dict:
    py = venv_python()
    marker = _marker_path()
    version = marker.read_text(encoding='utf-8').strip() if marker.is_file() else None
    if py and version:
        try:
            subprocess.run(
                [str(py), '-c', 'import faster_whisper'],
                check=True,
                capture_output=True,
                timeout=60,
            )
            return _info(state='installed', version=version, path=str(py))
        except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired) as exc:
            return _info(
                state='error',
                version=version,
                path=str(py),
                error=f'Whisper marker present but import failed: {exc}',
            )
    return _info(state='missing')


def _download_size(py: Path, size: str) -> None:
    root = whisper_models_dir()
    root.mkdir(parents=True, exist_ok=True)
    PROGRESS.emit(DEP_ID, 'downloading', message=f'Downloading Whisper {size} model…')
    token = _hf_token()
    token_repr = repr(token) if token else 'None'
    script = (
        'from faster_whisper.utils import download_model; '
        f'download_model({size!r}, cache_dir={str(root)!r}, use_auth_token={token_repr})'
    )
    try:
        dl = subprocess.run(
            [str(py), '-c', script],
            capture_output=True,
            text=True,
            timeout=_DOWNLOAD_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f'Whisper model download timed out after {_DOWNLOAD_TIMEOUT_SEC}s'
        ) from exc
    if dl.returncode != 0:
        raise RuntimeError(
            f'Whisper model download failed:\n{dl.stderr or dl.stdout}',
        )


def _install_packages(py: Path) -> None:
    req = requirements_whisper_pypi()
    PROGRESS.emit(DEP_ID, 'installing', message='Installing faster-whisper…')
    pip_cmd = (
        [str(py), '-m', 'pip', 'install', '-r', str(req)]
        if req.is_file()
        else [str(py), '-m', 'pip', 'install', 'faster-whisper>=1.1,<2']
    )
    try:
        pip = subprocess.run(
            pip_cmd,
            capture_output=True,
            text=True,
            timeout=_PIP_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f'faster-whisper install timed out after {_PIP_TIMEOUT_SEC}s'
        ) from exc
    if pip.returncode != 0:
        raise RuntimeError(f'faster-whisper install failed:\n{pip.stderr or pip.stdout}')
    _marker_path().write_text('whisper\n', encoding='utf-8')


def install(*, force: bool = False, variant: str | None = None) -> dict:
    size = normalize_whisper_size(variant)
    logger.info('install whisper force=%s size=%s', force, size)
    rt = python_runtime_provider.status()
    if rt['state'] != 'installed':
        PROGRESS.emit(DEP_ID, 'installing', message='Preparing Python runtime…')
        python_runtime_provider.install(force=False)

    py = venv_python()
    if not py:
        raise RuntimeError('Python runtime venv is missing; install Python runtime first.')

    packages_ready = (not force) and status()['state'] == 'installed'
    if not packages_ready:
        _install_packages(py)

    if not force and size_is_downloaded(size):
        logger.info('whisper size=%s already on disk path=%s', size, py)
        PROGRESS.emit(DEP_ID, 'done', message=f'Whisper {size} already downloaded')
        return status()

    _download_size(py, size)
    logger.info('whisper ready path=%s size=%s', py, size)
    PROGRESS.emit(DEP_ID, 'done', message=f'Whisper STT ready ({size})')
    return status()


def delete() -> dict:
    py = venv_python()
    marker = _marker_path()
    logger.info('delete whisper path=%s', py)
    if py and py.is_file():
        PROGRESS.emit(DEP_ID, 'installing', message='Uninstalling Whisper packages…')
        subprocess.run(
            [str(py), '-m', 'pip', 'uninstall', '-y', 'faster-whisper', 'ctranslate2'],
            capture_output=True,
            text=True,
        )
    if marker.exists():
        marker.unlink(missing_ok=True)
    models = whisper_models_dir()
    if models.is_dir():
        PROGRESS.emit(DEP_ID, 'installing', message='Removing Whisper model weights…')
        shutil.rmtree(models, ignore_errors=True)
    PROGRESS.emit(DEP_ID, 'done', message='Whisper STT removed')
    return status()
