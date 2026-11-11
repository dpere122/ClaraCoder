"""Install rust-analyzer (https://github.com/rust-lang/rust-analyzer) from its GitHub release.

rust-analyzer publishes a binary for every platform Clara runs on, so nothing is built from source.
Each version lives in its own ``<runtime>/rust-analyzer/<tag>/`` directory with its own ready marker.

Only the pinned release is installed: its assets' SHA-256 digests are in this file, and the releases
carry no checksum file to check another tag against. ``CLARA_RUST_LSP_COMMAND`` runs another build.
"""

from __future__ import annotations

import gzip
import hashlib
import logging
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from clara_coder_backend.runtime.deps.cancel import raise_if_cancelled
from clara_coder_backend.runtime.deps.download import (
    chmod_executable,
    download_file,
    extract_archive,
    read_ready_marker,
    with_download_lock,
    write_ready_marker,
)
from clara_coder_backend.runtime.deps.paths import get_runtime_downloads_dir, get_runtime_rust_analyzer_dir
from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.rust_analyzer')

DEP_ID = 'rust-analyzer'
LABEL = 'Rust LSP (rust-analyzer)'
DESCRIPTION = 'Rust language server. Needs a Rust toolchain (cargo) on this computer.'
SIZE_HINT = '~18 MB download'

REPO_URL = 'https://github.com/rust-lang/rust-analyzer'
#: rust-analyzer tags its weekly releases by date.
DEFAULT_TAG = '2026-11-09'
# SHA-256 of the assets of ``DEFAULT_TAG``, as GitHub reports them for the release. Update with the tag.
_PINNED_SHA256 = {
    'rust-analyzer-x86_64-pc-windows-msvc.zip': '973ab11e84955a7f8e3cf01ccd98a33f3ecbd6d4a14bf59bb164aa9e831c6fef',
    'rust-analyzer-aarch64-pc-windows-msvc.zip': 'ca0770b76d3881642221d0437f7535e324f22a9499bcd00bbebeb0228617249e',
    'rust-analyzer-x86_64-unknown-linux-gnu.gz': '8c039b25cb338b3970c731646677a4c9d4e9dd7a92c9ab9ae459c71467fbf4a9',
    'rust-analyzer-aarch64-unknown-linux-gnu.gz': '813ca3cec78ac6dab99c7bc9d51e63578f6d401b994ecf29cc0dcad86f9b2cd4',
    'rust-analyzer-x86_64-apple-darwin.gz': 'abf410a54e33e9f8b2d37f76dde8884db86a030d6a9cc70c0e3f87a77c084c5c',
    'rust-analyzer-aarch64-apple-darwin.gz': 'e43a65008f8f4291320f33c0545dd577ad7623a7407b584a27155833d3722dfb',
}
_VERSION_CHECK_TIMEOUT_S = 20
_STAGING_PREFIX = '.staging-'
# A stopped server keeps its executable locked on Windows for a moment after it exits.
_REMOVE_ATTEMPTS = 5
_REMOVE_RETRY_S = 0.5

_TAG_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

# Installs and deletes running in this process; while any runs, no server may start.
_changing_install = 0
_changing_install_lock = threading.Lock()


def _binary_name() -> str:
    return 'rust-analyzer.exe' if sys.platform.startswith('win') else 'rust-analyzer'


def release_asset_name() -> str | None:
    """Release asset for this platform, or None when rust-analyzer publishes none Clara can use."""

    machine = platform.machine().lower()
    if machine in {'x86_64', 'amd64'}:
        arch = 'x86_64'
    elif machine in {'arm64', 'aarch64'}:
        arch = 'aarch64'
    else:
        return None
    if sys.platform.startswith('win'):
        return f'rust-analyzer-{arch}-pc-windows-msvc.zip'
    if sys.platform.startswith('linux'):
        return f'rust-analyzer-{arch}-unknown-linux-gnu.gz'
    if sys.platform == 'darwin':
        return f'rust-analyzer-{arch}-apple-darwin.gz'
    return None


def _version_dir(tag: str) -> Path:
    return get_runtime_rust_analyzer_dir() / tag


def _is_ready(version_dir: Path) -> bool:
    return (version_dir / _binary_name()).is_file() and read_ready_marker(version_dir) is not None


def installed_version_dir() -> Path | None:
    """Directory of the install to run: the pinned tag when ready, else the newest ready one.

    An older install keeps Rust files working until the user updates it from Dependencies. This
    only looks at the disk, so status and server start never touch the network.
    """

    target = _version_dir(DEFAULT_TAG)
    if _is_ready(target):
        return target
    root = get_runtime_rust_analyzer_dir()
    if not root.is_dir():
        return None
    # Date tags sort by name.
    ready = [entry for entry in root.iterdir() if entry.is_dir() and _TAG_RE.match(entry.name) and _is_ready(entry)]
    return max(ready, key=lambda entry: entry.name) if ready else None


def installed_binary() -> Path | None:
    """Path of the ``rust-analyzer`` executable to run, or None when it is missing or being replaced."""

    with _changing_install_lock:
        if _changing_install:
            return None
    version_dir = installed_version_dir()
    return version_dir / _binary_name() if version_dir is not None else None


def components() -> list[str]:
    return ['rust-analyzer']


def status() -> dict:
    version_dir = installed_version_dir()
    base = {
        'id': DEP_ID,
        'label': LABEL,
        'description': DESCRIPTION,
        'sizeHint': SIZE_HINT,
        'canDelete': True,
        'error': None,
    }
    if version_dir is not None:
        return {
            **base,
            'version': read_ready_marker(version_dir),
            'state': 'installed',
            'path': str(version_dir / _binary_name()),
        }
    return {**base, 'version': None, 'state': 'missing', 'path': None}


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _check_runs(binary: Path) -> None:
    """Fail the install when the binary does not start, before it gets its ready marker."""

    flags = subprocess.CREATE_NO_WINDOW if sys.platform.startswith('win') else 0
    try:
        done = subprocess.run(
            [str(binary), '--version'],
            capture_output=True,
            text=True,
            timeout=_VERSION_CHECK_TIMEOUT_S,
            creationflags=flags,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f'Installed rust-analyzer did not start: {exc}') from exc
    if done.returncode != 0:
        raise RuntimeError(
            f'Installed rust-analyzer exited with code {done.returncode}: {done.stderr.strip()[:300]}'
        )


def _unpack(archive: Path, staging: Path) -> Path:
    """Put the executable from ``archive`` in a fresh ``staging`` directory and return its path.

    Windows assets are a zip; the others are the bare executable, gzipped.
    """

    binary = staging / _binary_name()
    if archive.name.endswith('.zip'):
        extract_archive(archive, staging)
        found = next((p for p in staging.rglob(_binary_name()) if p.is_file()), None)
        if found is None:
            raise RuntimeError(f'{_binary_name()} not found in {archive.name}.')
        if found.resolve() != binary.resolve():
            shutil.copy2(found, binary)
        return binary
    if staging.exists():
        _remove_tree(staging)
    staging.mkdir(parents=True)
    with gzip.open(archive, 'rb') as source, binary.open('wb') as target:
        shutil.copyfileobj(source, target)
    return binary


def _install_release(tag: str, asset: str) -> None:
    downloads = get_runtime_downloads_dir()
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / asset
    PROGRESS.emit(DEP_ID, 'downloading', message=f'Downloading {asset}…')

    def _progress(done: int, total: int | None) -> None:
        PROGRESS.emit(DEP_ID, 'downloading', bytes_done=done, bytes_total=total, message=f'Downloading {asset}…')

    expected = _PINNED_SHA256[asset]
    download_file(f'{REPO_URL}/releases/download/{tag}/{asset}', archive, on_progress=_progress, timeout=300)
    actual = _sha256_of(archive)
    if actual != expected:
        archive.unlink(missing_ok=True)
        raise RuntimeError(f'Checksum mismatch for {asset}: expected {expected}, got {actual}. Nothing was installed.')

    PROGRESS.emit(DEP_ID, 'extracting', message='Unpacking…')
    staging = get_runtime_rust_analyzer_dir() / f'{_STAGING_PREFIX}{tag}'
    binary = _unpack(archive, staging)
    archive.unlink(missing_ok=True)
    chmod_executable(binary)
    PROGRESS.emit(DEP_ID, 'finishing', message='Checking the installed binary…')
    _check_runs(binary)
    write_ready_marker(staging, tag)
    target = _version_dir(tag)
    if target.exists():
        _remove_tree(target)
    staging.replace(target)


def _stop_running_servers() -> None:
    """Stop running rust-analyzer processes: on Windows an executable can't be replaced while it runs.

    A running server belongs to the backend process; the Electron bootstrap CLI has none to stop.
    """

    try:
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions

        shutdown_lsp_server_for_all_sessions('rust')
    except Exception as exc:
        logger.warning('could not stop running rust-analyzer servers: %s', exc)


@contextmanager
def _servers_held_off() -> Iterator[None]:
    """Stop rust-analyzer and keep it stopped until the install on disk has finished changing.

    The editor keeps sending LSP requests during a download; any of them would otherwise restart
    the old binary and lock it again. Requests in this window report it as not installed, and the
    next one after it starts the new binary.
    """

    global _changing_install
    with _changing_install_lock:
        _changing_install += 1
    try:
        _stop_running_servers()
        yield
    finally:
        with _changing_install_lock:
            _changing_install -= 1


def _remove_tree(path: Path) -> None:
    for attempt in range(_REMOVE_ATTEMPTS):
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return
        if attempt < _REMOVE_ATTEMPTS - 1:
            time.sleep(_REMOVE_RETRY_S)
    raise RuntimeError(f'Could not remove {path}. A rust-analyzer process may still be using it.')


def install(*, force: bool = False) -> dict:
    tag = DEFAULT_TAG
    target = _version_dir(tag)
    if not force and _is_ready(target) and read_ready_marker(target) == tag:
        logger.info('rust-analyzer already installed path=%s', target)
        PROGRESS.emit(DEP_ID, 'done', message='Already installed')
        return status()

    asset = release_asset_name()
    if asset is None or asset not in _PINNED_SHA256:
        raise RuntimeError(
            f'rust-analyzer has no download for this platform ({sys.platform} {platform.machine()}). '
            'Install it yourself and point CLARA_RUST_LSP_COMMAND at it.'
        )
    logger.info('install rust-analyzer tag=%s asset=%s force=%s', tag, asset, force)
    raise_if_cancelled()
    get_runtime_rust_analyzer_dir().mkdir(parents=True, exist_ok=True)
    lock_path = get_runtime_downloads_dir() / 'rust-analyzer.lock'

    def _ready() -> bool:
        return not force and _is_ready(target)

    with _servers_held_off(), with_download_lock(lock_path, ready_check=_ready) as lock:
        if lock.held:
            _install_release(tag, asset)
            _remove_other_versions(keep=tag)

    logger.info('rust-analyzer ready path=%s', target)
    PROGRESS.emit(DEP_ID, 'done', message=f'rust-analyzer {tag} ready')
    return status()


def _remove_other_versions(*, keep: str) -> None:
    for entry in get_runtime_rust_analyzer_dir().iterdir():
        if entry.is_dir() and entry.name != keep and _TAG_RE.match(entry.name):
            shutil.rmtree(entry, ignore_errors=True)


def delete() -> dict:
    root = get_runtime_rust_analyzer_dir()
    logger.info('delete rust-analyzer root=%s', root)
    with _servers_held_off():
        if root.exists():
            _remove_tree(root)
        cleanup_partial()
    PROGRESS.emit(DEP_ID, 'done', message='rust-analyzer removed')
    return status()


def cleanup_partial() -> None:
    """Remove what a cancelled install leaves: the downloaded asset and staging directories."""

    downloads = get_runtime_downloads_dir()
    if downloads.is_dir():
        for entry in downloads.iterdir():
            if entry.is_file() and entry.name.startswith('rust-analyzer-'):
                entry.unlink(missing_ok=True)
    root = get_runtime_rust_analyzer_dir()
    if root.is_dir():
        for entry in root.iterdir():
            if entry.is_dir() and entry.name.startswith(_STAGING_PREFIX):
                shutil.rmtree(entry, ignore_errors=True)
