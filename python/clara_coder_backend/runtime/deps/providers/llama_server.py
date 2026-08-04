"""Download pinned llama-server binaries from ggml-org/llama.cpp releases."""

from __future__ import annotations

import logging
import platform
import shutil
import sys
from pathlib import Path

from clara_coder_backend.runtime.deps.download import (
    READY_MARKER,
    chmod_executable,
    download_file,
    extract_archive,
    read_ready_marker,
    with_download_lock,
    write_ready_marker,
)
from clara_coder_backend.runtime.deps.paths import (
    get_runtime_bin_dir,
    get_runtime_downloads_dir,
    llama_server_binary,
)
from clara_coder_backend.runtime.deps.progress import PROGRESS
from clara_coder_backend.session.config import env_clara

logger = logging.getLogger('clara.runtime.deps.llama_server')

DEP_ID = 'llama-server'
# Pin a known release tag; override with CLARA_LLAMA_SERVER_VERSION (e.g. b10262).
DEFAULT_TAG = 'b10262'
SIZE_HINT = '~40–80 MB'


def _pinned_tag() -> str:
    return env_clara('CLARA_LLAMA_SERVER_VERSION', DEFAULT_TAG).strip() or DEFAULT_TAG


def _asset_name(tag: str) -> str:
    system = sys.platform
    machine = platform.machine().lower()
    if system.startswith('linux'):
        if machine in ('aarch64', 'arm64'):
            return f'llama-{tag}-bin-ubuntu-arm64.tar.gz'
        return f'llama-{tag}-bin-ubuntu-x64.tar.gz'
    if system == 'darwin':
        if machine in ('aarch64', 'arm64'):
            return f'llama-{tag}-bin-macos-arm64.tar.gz'
        return f'llama-{tag}-bin-macos-x64.tar.gz'
    if system.startswith('win'):
        return f'llama-{tag}-bin-win-cpu-x64.zip'
    raise RuntimeError(f'Unsupported platform for llama-server: {system}/{machine}')


def _find_binary_in_tree(root: Path) -> Path | None:
    names = ('llama-server.exe', 'llama-server')
    for name in names:
        direct = root / name
        if direct.is_file():
            return direct
    for name in names:
        matches = list(root.rglob(name))
        if matches:
            return matches[0]
    return None


def status() -> dict:
    bin_path = llama_server_binary()
    marker_dir = get_runtime_bin_dir()
    version = read_ready_marker(marker_dir)
    # Binary presence is enough for Electron spawn; marker supplies version when present.
    if bin_path.is_file():
        return {
            'id': DEP_ID,
            'label': 'llama-server',
            'description': 'llama.cpp server binary for managed local models.',
            'version': version or 'installed',
            'state': 'installed',
            'path': str(bin_path),
            'sizeHint': SIZE_HINT,
            'canDelete': True,
            'error': None,
        }
    return {
        'id': DEP_ID,
        'label': 'llama-server',
        'description': 'llama.cpp server binary for managed local models.',
        'version': None,
        'state': 'missing',
        'path': None,
        'sizeHint': SIZE_HINT,
        'canDelete': True,
        'error': None,
    }


def install(*, force: bool = False) -> dict:
    tag = _pinned_tag()
    logger.info('install llama-server tag=%s force=%s', tag, force)
    bin_dir = get_runtime_bin_dir()
    bin_path = llama_server_binary()
    if not force and bin_path.is_file() and read_ready_marker(bin_dir) == tag:
        logger.info('llama-server already installed path=%s version=%s', bin_path, tag)
        PROGRESS.emit(DEP_ID, 'done', message='Already installed')
        return status()

    asset = _asset_name(tag)
    url = f'https://github.com/ggml-org/llama.cpp/releases/download/{tag}/{asset}'
    downloads = get_runtime_downloads_dir()
    archive = downloads / asset
    extract_dir = downloads / f'llama-extract-{tag}'
    lock = downloads / f'.llama-{tag}.lock'

    def _ready() -> bool:
        return bin_path.is_file() and read_ready_marker(bin_dir) == tag

    with with_download_lock(lock, ready_check=_ready) as lock_ctx:
        if not lock_ctx.held and _ready():
            return status()
        if force and bin_path.exists():
            bin_path.unlink(missing_ok=True)
            (bin_dir / READY_MARKER).unlink(missing_ok=True)

        PROGRESS.emit(DEP_ID, 'downloading', message=f'Downloading {asset}…')

        def _prog(done: int, total: int | None) -> None:
            PROGRESS.emit(
                DEP_ID,
                'downloading',
                bytes_done=done,
                bytes_total=total,
                message=f'Downloading {asset}…',
            )

        download_file(url, archive, on_progress=_prog, timeout=300)
        PROGRESS.emit(DEP_ID, 'extracting', message='Extracting archive…')
        extract_archive(archive, extract_dir)
        found = _find_binary_in_tree(extract_dir)
        if not found:
            logger.error('llama-server binary missing from archive %s', asset)
            raise RuntimeError(f'llama-server binary not found in {asset}')
        bin_dir.mkdir(parents=True, exist_ok=True)
        if bin_path.exists():
            bin_path.unlink()
        shutil.copy2(found, bin_path)
        chmod_executable(bin_path)
        write_ready_marker(bin_dir, tag)
        shutil.rmtree(extract_dir, ignore_errors=True)

    logger.info('llama-server ready path=%s version=%s', bin_path, tag)
    PROGRESS.emit(DEP_ID, 'done', message='llama-server ready')
    return status()


def delete() -> dict:
    bin_dir = get_runtime_bin_dir()
    bin_path = llama_server_binary()
    logger.info('delete llama-server path=%s', bin_path)
    if bin_path.exists():
        bin_path.unlink(missing_ok=True)
    (bin_dir / READY_MARKER).unlink(missing_ok=True)
    PROGRESS.emit(DEP_ID, 'done', message='llama-server removed')
    return status()
