"""Resolve app-data runtime directories for managed dependencies."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from clara_coder_backend.config import env_clara

BUNDLED_RUNTIME_MANIFEST = '.clara-runtime-manifest.json'


def bundled_python_executable() -> Path | None:
    """Absolute bundled interpreter from ``CLARA_BUNDLED_PYTHON``, if the file exists."""
    raw = env_clara('CLARA_BUNDLED_PYTHON', '').strip()
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_file() else None


def bundled_runtime_dir() -> Path | None:
    """Bundle root containing ``.clara-runtime-manifest.json``, or the exe parent."""
    raw = env_clara('CLARA_BUNDLED_RUNTIME_DIR', '').strip()
    if raw:
        path = Path(raw)
        if path.is_dir():
            return path
    exe = bundled_python_executable()
    if exe is None:
        return None
    parent = exe.parent
    if (parent / BUNDLED_RUNTIME_MANIFEST).is_file():
        return parent
    grand = parent.parent
    if (grand / BUNDLED_RUNTIME_MANIFEST).is_file():
        return grand
    return parent


def read_bundled_runtime_manifest() -> dict | None:
    """Load ``.clara-runtime-manifest.json``; None when missing or invalid (never raises)."""
    root = bundled_runtime_dir()
    if root is None:
        return None
    path = root / BUNDLED_RUNTIME_MANIFEST
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def venv_belongs_to_bundled(root: Path, bundled_exe: Path) -> bool:
    """True when ``root/pyvenv.cfg`` ``home`` is the bundled interpreter's directory."""
    home = read_pyvenv_home(root)
    if home is None:
        return False
    try:
        home_s = os.path.normcase(str(home.resolve())).rstrip('\\/')
        bundled_s = os.path.normcase(str(bundled_exe.parent.resolve())).rstrip('\\/')
    except OSError:
        return False
    return home_s == bundled_s


def get_runtime_dir() -> Path:
    raw = env_clara('CLARA_RUNTIME_DIR', '').strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path(tempfile.gettempdir()) / 'clara-coder-runtime').resolve()


def get_runtime_python_dir() -> Path:
    raw = env_clara('CLARA_RUNTIME_PYTHON_DIR', '').strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return get_runtime_dir() / 'python-venv'


def get_runtime_bin_dir() -> Path:
    raw = env_clara('CLARA_RUNTIME_BIN_DIR', '').strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return get_runtime_dir() / 'bin'


def get_runtime_java_lsp_dir() -> Path:
    raw = env_clara('CLARA_JAVA_LSP_CACHE_DIR', '').strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return get_runtime_dir() / 'java-lsp'


def get_runtime_downloads_dir() -> Path:
    return get_runtime_dir() / 'downloads'


def read_pyvenv_home(root: Path) -> Path | None:
    """``home = …`` (base interpreter directory) from ``root/pyvenv.cfg``, or None."""
    try:
        text = (root / 'pyvenv.cfg').read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None
    for raw in text.splitlines():
        key, sep, value = raw.partition('=')
        if not sep or key.strip().lower() != 'home':
            continue
        value = value.strip()
        return Path(value) if value else None
    return None


def _base_interpreter_exists(home: Path) -> bool:
    if not home.is_dir():
        return False
    names = ('python.exe',) if sys.platform.startswith('win') else ('python3', 'python')
    return any((home / name).is_file() for name in names)


def venv_unusable_reason(root: Path) -> str | None:
    """Why the venv at ``root`` cannot launch, or None when it looks fine.

    - ``pyvenv.cfg`` missing: the Windows venv launcher exits 106 ("No pyvenv.cfg file");
      an interrupted ``python -m venv`` leaves ``Scripts/python.exe`` behind without it.
    - ``home`` base interpreter missing: the launcher exits 103 ("No Python at '…'").
      Happens when the venv was created from the bundled portable Python of an app
      install that was since uninstalled or moved.
    """
    if not (root / 'pyvenv.cfg').is_file():
        return 'missing pyvenv.cfg'
    home = read_pyvenv_home(root)
    if home is not None and not _base_interpreter_exists(home):
        return f'base interpreter missing at {home}'
    exe = bundled_python_executable()
    if exe is not None and not venv_belongs_to_bundled(root, exe):
        return f'not created from the bundled runtime (home={home})'
    return None


def is_usable_venv(root: Path) -> bool:
    """True when ``root`` has ``pyvenv.cfg`` and its ``home`` interpreter still exists."""
    return venv_unusable_reason(root) is None


def venv_python(venv_dir: Path | None = None) -> Path | None:
    root = venv_dir or get_runtime_python_dir()
    if not is_usable_venv(root):
        return None
    if sys.platform.startswith('win'):
        cand = root / 'Scripts' / 'python.exe'
    else:
        cand = root / 'bin' / 'python'
    return cand if cand.is_file() else None


def llama_server_binary() -> Path:
    name = 'llama-server.exe' if sys.platform.startswith('win') else 'llama-server'
    return get_runtime_bin_dir() / name


def python_package_root() -> Path:
    """``python/`` directory containing ``requirements.txt`` and ``clara_coder_backend``."""
    # …/python/clara_coder_backend/runtime/deps/paths.py → parents[3] == python/
    return Path(__file__).resolve().parents[3]


def requirements_txt() -> Path:
    return python_package_root() / 'requirements.txt'


def requirements_kokoro_pypi() -> Path:
    return python_package_root() / 'requirements-kokoro-pypi.txt'


def requirements_whisper_pypi() -> Path:
    return python_package_root() / 'requirements-whisper-pypi.txt'


def whisper_models_dir(custom_models_dir: str = '') -> Path:
    """Directory for faster-whisper Hub weights (``{customModelsDir}/whisper``)."""
    raw = (custom_models_dir or env_clara('CLARA_CUSTOM_MODELS_DIR', '')).strip()
    if not raw:
        raw = str(Path.home() / 'ClaraCoder' / 'models')
    return Path(raw).expanduser().resolve() / 'whisper'
