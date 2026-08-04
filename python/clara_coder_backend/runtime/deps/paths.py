"""Resolve app-data runtime directories for managed dependencies."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from clara_coder_backend.config import env_clara


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


def venv_python(venv_dir: Path | None = None) -> Path | None:
    root = venv_dir or get_runtime_python_dir()
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
