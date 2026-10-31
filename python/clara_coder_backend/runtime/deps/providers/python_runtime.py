"""Ensure app-managed Python venv + core requirements.txt.

Not a listed dependency: Kokoro and Whisper call :func:`install` as the first step of
their own installs, and its progress is reported under their id.
"""

from __future__ import annotations

import hashlib
import logging
import os
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
    bundled_python_executable,
    get_runtime_python_dir,
    read_bundled_runtime_manifest,
    requirements_txt,
    venv_python,
    venv_unusable_reason,
)
from clara_coder_backend.runtime.deps.progress import PROGRESS
from clara_coder_backend.config import env_clara

logger = logging.getLogger('clara.runtime.deps.python_runtime')

DEP_ID = 'python-runtime'
REQ_HASH_MARKER = '.clara-requirements-hash'

# Cached ``_base_has_core`` result for the bundled interpreter (status() polls often).
_BUNDLED_CORE_OK: bool | None = None


def _requirements_fingerprint() -> str:
    """SHA-256 of ``python/requirements.txt`` so existing venvs pick up new deps."""

    req = requirements_txt()
    try:
        data = req.read_bytes()
    except OSError:
        return ''
    return hashlib.sha256(data).hexdigest()


def _bundled_requirements_hash() -> str:
    manifest = read_bundled_runtime_manifest()
    if not isinstance(manifest, dict):
        return ''
    raw = manifest.get('requirementsSha256')
    return raw if isinstance(raw, str) else ''


def _expected_requirements_hash() -> str:
    """Manifest SHA when a bundled runtime is present; else ``requirements.txt`` fingerprint."""
    if bundled_python_executable() is not None and read_bundled_runtime_manifest() is not None:
        return _bundled_requirements_hash()
    return _requirements_fingerprint()


def _write_requirements_hash(venv: Path) -> None:
    digest = _expected_requirements_hash()
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
    digest = _expected_requirements_hash()
    return bool(stored) and stored == digest


def _pip_install_requirements(python_exe: Path, dep_id: str) -> None:
    req = requirements_txt()
    if not req.is_file():
        raise RuntimeError(f'Missing requirements file: {req}')
    # Streamed so every "Collecting / Downloading / Installing" line pip prints
    # lands in the Dependencies window install log.
    try:
        run_streaming(
            [str(python_exe), '-m', 'pip', 'install', '-r', str(req)],
            dep_id=dep_id,
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


def _base_has_core(base_exe: str) -> bool:
    """True when isolated ``base_exe`` can import fastapi and uvicorn."""
    try:
        r = subprocess.run(
            [base_exe, '-I', '-c', 'import fastapi, uvicorn'],
            capture_output=True,
            timeout=60,
            check=False,
        )
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _bundled_core_importable(base_exe: str) -> bool:
    """``_base_has_core`` for the bundled interpreter, cached for the process lifetime."""
    global _BUNDLED_CORE_OK
    if _BUNDLED_CORE_OK is None:
        _BUNDLED_CORE_OK = _base_has_core(base_exe)
    return _BUNDLED_CORE_OK


def _base_python(target_venv: Path) -> str:
    """Return an interpreter that can create ``target_venv``.

    Must not be the runtime venv itself — reinstall deletes that directory while the
    FastAPI sidecar may still be running from ``…/python-venv/bin/python``.
    When ``CLARA_BUNDLED_PYTHON`` points at an existing file it is the only candidate.
    """
    target = target_venv.resolve()
    bundled = bundled_python_executable()
    if bundled is not None:
        try:
            resolved = bundled.resolve()
        except OSError:
            resolved = bundled
        if resolved.is_file() and not _path_is_under(resolved, target):
            return str(resolved)
        raise RuntimeError(
            'No durable Python interpreter available to create the runtime venv. '
            'Install Python 3 or set CLARA_PYTHON to a system/portable interpreter.'
        )

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


def _status(state: str, *, path: str | None, version: str | None, error: str | None = None) -> dict:
    return {'id': DEP_ID, 'state': state, 'path': path, 'version': version, 'error': error}


def status() -> dict:
    """State of the runtime venv for the Kokoro / Whisper installs (``installed`` when usable).

    ``error`` means :func:`install` must repair it; the sidecar skips a stale isolated venv meanwhile.
    """
    venv = get_runtime_python_dir()
    bundled = bundled_python_executable()
    if bundled is not None and venv_python(venv) is None and _bundled_core_importable(str(bundled)):
        manifest = read_bundled_runtime_manifest() or {}
        version = manifest.get('pythonVersion') or _interpreter_version(str(bundled))
        return _status('installed', path=str(bundled), version=version)
    py = venv_python(venv)
    version = read_ready_marker(venv)
    if py and version:
        if not _core_packages_importable(py):
            return _status('error', path=str(py), version=version, error='Venv present but core packages missing.')
        if not _requirements_current(venv):
            return _status('error', path=str(py), version=version, error='requirements.txt changed since setup.')
        return _status('installed', path=str(py), version=version)
    # pyvenv.cfg exists but its base interpreter is gone (e.g. previous app install removed).
    if (venv / 'pyvenv.cfg').is_file():
        reason = venv_unusable_reason(venv)
        if reason:
            return _status('error', path=str(venv), version=version, error=f'Runtime venv is unusable ({reason}).')
    return _status('missing', path=None, version=None)


def install(*, dep_id: str, force: bool = False) -> dict:
    """Create or refresh the runtime venv as a step of ``dep_id``'s install.

    Progress goes to ``dep_id`` and never reports ``done``: the caller's install goes on.
    """
    logger.info('install python-runtime force=%s', force)
    PROGRESS.emit(dep_id, 'installing', message='Creating virtualenv…')
    venv = get_runtime_python_dir()
    # Resolve before force-delete: sidecar often runs from this venv.
    base = _base_python(venv)
    bundled = bundled_python_executable() is not None
    overlay = bundled or _base_has_core(base)
    logger.info('python-runtime overlay=%s base=%s', overlay, base)

    unusable = venv_unusable_reason(venv) if venv.exists() else None
    if venv.exists() and (force or unusable):
        if unusable and not force:
            logger.warning('removing unusable runtime venv (%s) path=%s', unusable, venv)
            PROGRESS.emit(dep_id, 'installing', message=f'Recreating runtime venv ({unusable})…')
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
            PROGRESS.emit(dep_id, 'installing', message='Python runtime already set up')
            return st
        if bundled:
            logger.info('python-runtime bundled requirements hash stale; rewriting marker path=%s', existing)
            _write_requirements_hash(venv)
            PROGRESS.emit(dep_id, 'installing', message='Core packages come from the bundled runtime')
            return status()
        logger.info('python-runtime requirements.txt changed; updating packages path=%s', existing)
        PROGRESS.emit(dep_id, 'installing', message='Updating Python packages…')
        _pip_install_requirements(existing, dep_id)
        _write_requirements_hash(venv)
        PROGRESS.emit(dep_id, 'installing', message='Python runtime packages updated')
        return status()

    venv.mkdir(parents=True, exist_ok=True)
    argv = (
        [base, '-m', 'venv', '--system-site-packages', str(venv)]
        if overlay
        else [base, '-m', 'venv', str(venv)]
    )
    try:
        run_streaming(argv, dep_id=dep_id, label='venv create')
    except RuntimeError as exc:
        logger.error('python-runtime venv create failed: %s', exc)
        raise RuntimeError(f'Failed to create venv: {exc}') from exc

    py = venv_python(venv)
    if not py:
        raise RuntimeError(f'Venv created but python missing under {venv}')

    PROGRESS.emit(dep_id, 'installing', message='Bootstrapping pip…')
    run_streaming(
        [str(py), '-m', 'ensurepip', '--upgrade'],
        dep_id=dep_id,
        label='ensurepip',
        check=False,
    )

    if overlay:
        PROGRESS.emit(
            dep_id,
            'installing',
            message='Core packages provided by the bundled runtime; skipping pip install',
        )
    else:
        PROGRESS.emit(dep_id, 'installing', message='Installing core packages…')
        _pip_install_requirements(py, dep_id)

    # Version of the venv interpreter (matches ``base``), not the possibly-different sidecar.
    ver = _interpreter_version(str(py))
    write_ready_marker(venv, ver)
    _write_requirements_hash(venv)
    logger.info('python-runtime ready path=%s version=%s', py, ver)
    PROGRESS.emit(dep_id, 'installing', message='Python runtime ready')
    return status()
