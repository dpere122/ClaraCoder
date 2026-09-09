"""Ensure app-managed Python venv + core requirements.txt."""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from clara_coder_backend.runtime.deps.download import (
    read_ready_marker,
    run_streaming,
    write_ready_marker,
)
from clara_coder_backend.runtime.deps.paths import (
    get_runtime_python_dir,
    is_usable_venv,
    requirements_txt,
    venv_python,
)
from clara_coder_backend.runtime.deps.progress import PROGRESS
from clara_coder_backend.config import env_clara

logger = logging.getLogger('clara.runtime.deps.python_runtime')

DEP_ID = 'python-runtime'
SIZE_HINT = '~150 MB (venv + core packages)'
REQ_HASH_MARKER = '.clara-requirements-hash'


_REQ_NAME_END = re.compile(r'[\s\[<>=!~;@]')


def requirement_names(text: str) -> list[str]:
    """Distribution names from requirements.txt text (comments/options/markers stripped)."""

    names: list[str] = []
    for raw in text.splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line or line.startswith('-'):
            continue
        name = _REQ_NAME_END.split(line, 1)[0].strip()
        if name and name not in names:
            names.append(name)
    return names


def components() -> list[str]:
    """Packages this dependency installs: venv + pip, then everything in requirements.txt."""

    try:
        text = requirements_txt().read_text(encoding='utf-8')
    except OSError:
        text = ''
    return ['venv', 'pip', *requirement_names(text)]


def _requirements_fingerprint() -> str:
    """SHA-256 of ``python/requirements.txt`` so existing venvs pick up new deps."""

    req = requirements_txt()
    try:
        data = req.read_bytes()
    except OSError:
        return ''
    return hashlib.sha256(data).hexdigest()


def _write_requirements_hash(venv: Path) -> None:
    digest = _requirements_fingerprint()
    if not digest:
        return
    venv.mkdir(parents=True, exist_ok=True)
    (venv / REQ_HASH_MARKER).write_text(digest + '\n', encoding='utf-8')


def _requirements_current(venv: Path) -> bool:
    marker = venv / REQ_HASH_MARKER
    try:
        stored = marker.read_text(encoding='utf-8').strip()
    except OSError:
        return False
    digest = _requirements_fingerprint()
    return bool(stored) and stored == digest


def _pip_install_requirements(python_exe: Path) -> None:
    req = requirements_txt()
    if not req.is_file():
        raise RuntimeError(f'Missing requirements file: {req}')
    # Streamed so every "Collecting / Downloading / Installing" line pip prints
    # lands in the Dependencies window install log.
    try:
        run_streaming(
            [str(python_exe), '-m', 'pip', 'install', '-r', str(req)],
            dep_id=DEP_ID,
            label='pip install',
        )
    except RuntimeError:
        logger.error('python-runtime pip install failed')
        raise



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


def _core_packages_importable(python_exe: Path) -> bool:
    """True when ``fastapi`` and ``uvicorn`` import in the runtime venv."""

    try:
        subprocess.run(
            [str(python_exe), '-c', 'import fastapi, uvicorn'],
            check=True,
            capture_output=True,
            timeout=30,
        )
        return True
    except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired):
        return False


def status() -> dict:
    venv = get_runtime_python_dir()
    py = venv_python(venv)
    version = read_ready_marker(venv)
    if py and version:
        if _core_packages_importable(py):
            if not _requirements_current(venv):
                return {
                    'id': DEP_ID,
                    'label': 'Python runtime',
                    'description': 'App-managed virtualenv with Clara backend packages.',
                    'version': version,
                    'state': 'error',
                    'path': str(py),
                    'sizeHint': SIZE_HINT,
                    'canDelete': True,
                    'error': 'requirements.txt changed; use Download to update packages.',
                }
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
        return {
            'id': DEP_ID,
            'label': 'Python runtime',
            'description': 'App-managed virtualenv with Clara backend packages.',
            'version': version,
            'state': 'error',
            'path': str(py),
            'sizeHint': SIZE_HINT,
            'canDelete': True,
            'error': 'Venv present but core packages missing.',
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

    incomplete = venv.exists() and not is_usable_venv(venv)
    if venv.exists() and (force or incomplete):
        if incomplete and not force:
            logger.warning('removing incomplete runtime venv (missing pyvenv.cfg) path=%s', venv)
        shutil.rmtree(venv, ignore_errors=True)

    existing = venv_python(venv)
    if existing and not force and read_ready_marker(venv) and _core_packages_importable(existing):
        if _requirements_current(venv):
            st = status()
            logger.info(
                'python-runtime already installed path=%s version=%s',
                st.get('path'),
                st.get('version'),
            )
            PROGRESS.emit(DEP_ID, 'done', message='Already installed')
            return st
        logger.info('python-runtime requirements.txt changed; updating packages path=%s', existing)
        PROGRESS.emit(DEP_ID, 'installing', message='Updating Python packages…')
        _pip_install_requirements(existing)
        _write_requirements_hash(venv)
        PROGRESS.emit(DEP_ID, 'done', message='Python runtime packages updated')
        return status()

    venv.mkdir(parents=True, exist_ok=True)
    try:
        run_streaming([base, '-m', 'venv', str(venv)], dep_id=DEP_ID, label='venv create')
    except RuntimeError as exc:
        logger.error('python-runtime venv create failed: %s', exc)
        raise RuntimeError(f'Failed to create venv: {exc}') from exc

    py = venv_python(venv)
    if not py:
        raise RuntimeError(f'Venv created but python missing under {venv}')

    PROGRESS.emit(DEP_ID, 'installing', message='Bootstrapping pip…')
    run_streaming(
        [str(py), '-m', 'ensurepip', '--upgrade'],
        dep_id=DEP_ID,
        label='ensurepip',
        check=False,
    )

    PROGRESS.emit(DEP_ID, 'installing', message='Installing core packages…')
    _pip_install_requirements(py)

    # Version of the venv interpreter (matches ``base``), not the possibly-different sidecar.
    ver = _interpreter_version(str(py))
    write_ready_marker(venv, ver)
    _write_requirements_hash(venv)
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
