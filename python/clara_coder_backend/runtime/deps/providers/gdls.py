"""Install the gdls GDScript language server (https://github.com/kurushimee/gdls).

gdls ships prebuilt binaries for Windows x64 and Linux x64 only, so:
  * Windows x64 / Linux x64 -> download the release archive and verify its SHA-256
  * everything else (macOS, arm64) -> ``cargo install`` the same tag; needs a Rust toolchain

Each version lives in its own ``<runtime>/gdls/<tag>/`` directory with its own ready marker, away
from ``runtime/bin`` (whose single marker and shared-library cleanup belong to llama-server).
``CLARA_GDLS_VERSION`` overrides the pinned tag; that build is checked against the release's
``SHA256SUMS`` because only the pinned assets have digests in this file.
"""

from __future__ import annotations

import hashlib
import logging
import os
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

from clara_coder_backend.config import env_clara
from clara_coder_backend.runtime.deps.cancel import raise_if_cancelled
from clara_coder_backend.runtime.deps.download import (
    chmod_executable,
    download_file,
    extract_archive,
    read_ready_marker,
    run_streaming,
    with_download_lock,
    write_ready_marker,
)
from clara_coder_backend.runtime.deps.paths import get_runtime_downloads_dir, get_runtime_gdls_dir
from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.gdls')

DEP_ID = 'gdls'
LABEL = 'GDScript LSP (gdls)'
DESCRIPTION = 'Standalone GDScript language server for Godot 4.6+. Needs no running Godot editor.'
SIZE_HINT = '~12 MB (macOS: built from source with Rust)'

REPO_URL = 'https://github.com/kurushimee/gdls'
DEFAULT_TAG = 'v3.1.1'
# SHA-256 of the assets of ``DEFAULT_TAG``, taken from the GitHub release. Update with the tag.
_PINNED_SHA256 = {
    'gdls-v3.1.1-windows-x86_64.zip': '828bcdcd1cf093f272146a2a13281c406e4fa00fd63453384fc476152226ab93',
    'gdls-v3.1.1-linux-x86_64.tar.gz': '5c26dfc02ac373b14bf4b471705a44e0b74b6c38c448ff16302582d4c53fca04',
}
_CHECKSUMS_ASSET = 'SHA256SUMS'
# A release build of the workspace from a cold cargo cache.
COMPILE_TIMEOUT_S = 1800
_VERSION_CHECK_TIMEOUT_S = 20
_STAGING_PREFIX = '.staging-'
# A stopped server keeps its executable locked on Windows for a moment after it exits.
_REMOVE_ATTEMPTS = 5
_REMOVE_RETRY_S = 0.5

_TAG_RE = re.compile(r'^v?\d+(\.\d+)*$')

# Installs and deletes running in this process; while any runs, no server may start.
_changing_install = 0
_changing_install_lock = threading.Lock()


def _binary_name() -> str:
    return 'gdls.exe' if sys.platform.startswith('win') else 'gdls'


def target_tag() -> str:
    """Release tag to install: ``CLARA_GDLS_VERSION`` when set and valid, else the pinned one."""

    raw = (env_clara('CLARA_GDLS_VERSION', '') or '').strip()
    if not raw:
        return DEFAULT_TAG
    if not _TAG_RE.match(raw):
        logger.warning('ignoring invalid CLARA_GDLS_VERSION=%r', raw)
        return DEFAULT_TAG
    return raw if raw.startswith('v') else f'v{raw}'


def prebuilt_asset_name(tag: str) -> str | None:
    """Release archive for this platform, or None when gdls publishes no binary for it."""

    machine = platform.machine().lower()
    if machine not in {'x86_64', 'amd64'}:
        return None
    if sys.platform.startswith('win'):
        return f'gdls-{tag}-windows-x86_64.zip'
    if sys.platform.startswith('linux'):
        return f'gdls-{tag}-linux-x86_64.tar.gz'
    return None


def _version_dir(tag: str) -> Path:
    return get_runtime_gdls_dir() / tag


def _is_ready(version_dir: Path) -> bool:
    return (version_dir / _binary_name()).is_file() and read_ready_marker(version_dir) is not None


def _version_sort_key(tag: str) -> tuple[int, ...]:
    return tuple(int(part) for part in tag.lstrip('v').split('.') if part.isdigit())


def installed_version_dir() -> Path | None:
    """Directory of the install to run: the target tag when ready, else the newest ready one.

    An older install keeps Godot files working until the user updates it from Dependencies. This
    only looks at the disk, so status and server start never touch the network.
    """

    target = _version_dir(target_tag())
    if _is_ready(target):
        return target
    root = get_runtime_gdls_dir()
    if not root.is_dir():
        return None
    ready = [
        entry
        for entry in root.iterdir()
        if entry.is_dir() and _TAG_RE.match(entry.name) and _is_ready(entry)
    ]
    if not ready:
        return None
    return max(ready, key=lambda entry: _version_sort_key(entry.name))


def installed_binary() -> Path | None:
    """Path of the ``gdls`` executable to run, or None when it is missing or being replaced."""

    with _changing_install_lock:
        if _changing_install:
            return None
    version_dir = installed_version_dir()
    return version_dir / _binary_name() if version_dir is not None else None


def components() -> list[str]:
    return ['gdls']


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


def parse_checksums(text: str) -> dict[str, str]:
    """Map asset name to digest from ``sha256sum`` output (``<hash>  name`` or ``<hash> *name``)."""

    out: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.strip().split(maxsplit=1)
        if len(parts) == 2 and re.fullmatch(r'[0-9a-fA-F]{64}', parts[0]):
            out[parts[1].lstrip('*').strip()] = parts[0].lower()
    return out


def _expected_sha256(tag: str, asset: str, downloads: Path) -> str:
    pinned = _PINNED_SHA256.get(asset)
    if pinned:
        return pinned
    sums_path = downloads / f'gdls-{tag}-{_CHECKSUMS_ASSET}'
    download_file(f'{REPO_URL}/releases/download/{tag}/{_CHECKSUMS_ASSET}', sums_path, timeout=60)
    try:
        expected = parse_checksums(sums_path.read_text(encoding='utf-8')).get(asset)
    finally:
        sums_path.unlink(missing_ok=True)
    if not expected:
        raise RuntimeError(f'{_CHECKSUMS_ASSET} of gdls {tag} has no entry for {asset}.')
    return expected


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
        raise RuntimeError(f'Installed gdls did not start: {exc}') from exc
    if done.returncode != 0:
        raise RuntimeError(f'Installed gdls exited with code {done.returncode}: {done.stderr.strip()[:300]}')


def _place_binary(found: Path, staging: Path, tag: str) -> None:
    """Move a checked binary from ``found`` to its version directory and mark it ready."""

    final_in_staging = staging / _binary_name()
    if found.resolve() != final_in_staging.resolve():
        shutil.copy2(found, final_in_staging)
    chmod_executable(final_in_staging)
    _check_runs(final_in_staging)
    write_ready_marker(staging, tag)
    target = _version_dir(tag)
    if target.exists():
        _remove_tree(target)
    staging.replace(target)


def _install_prebuilt(tag: str, asset: str) -> None:
    downloads = get_runtime_downloads_dir()
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / asset
    PROGRESS.emit(DEP_ID, 'downloading', message=f'Downloading {asset}…')

    def _progress(done: int, total: int | None) -> None:
        PROGRESS.emit(DEP_ID, 'downloading', bytes_done=done, bytes_total=total, message=f'Downloading {asset}…')

    expected = _expected_sha256(tag, asset, downloads)
    download_file(f'{REPO_URL}/releases/download/{tag}/{asset}', archive, on_progress=_progress, timeout=300)
    actual = _sha256_of(archive)
    if actual != expected:
        archive.unlink(missing_ok=True)
        raise RuntimeError(f'Checksum mismatch for {asset}: expected {expected}, got {actual}. Nothing was installed.')

    PROGRESS.emit(DEP_ID, 'extracting', message='Extracting archive…')
    staging = get_runtime_gdls_dir() / f'{_STAGING_PREFIX}{tag}'
    extract_archive(archive, staging)
    archive.unlink(missing_ok=True)
    found = next((p for p in staging.rglob(_binary_name()) if p.is_file()), None)
    if found is None:
        raise RuntimeError(f'{_binary_name()} not found in {asset}.')
    PROGRESS.emit(DEP_ID, 'finishing', message='Checking the installed binary…')
    _place_binary(found, staging, tag)


def _find_cargo() -> Path | None:
    on_path = shutil.which('cargo')
    if on_path:
        return Path(on_path)
    # Apps launched from Finder don't inherit the shell PATH that rustup edits.
    default = Path.home() / '.cargo' / 'bin' / ('cargo.exe' if sys.platform.startswith('win') else 'cargo')
    return default if default.is_file() else None


def _install_with_cargo(tag: str) -> None:
    cargo = _find_cargo()
    if cargo is None:
        raise RuntimeError(
            'gdls has no prebuilt binary for this platform, so it is built from source, which needs Rust. '
            'Install it from https://rustup.rs, then try again.'
        )
    root = get_runtime_gdls_dir()
    staging = root / f'{_STAGING_PREFIX}{tag}'
    if staging.exists():
        _remove_tree(staging)
    staging.mkdir(parents=True)
    build_dir = get_runtime_downloads_dir() / f'gdls-build-{tag}'
    env = dict(os.environ)
    env['CARGO_TARGET_DIR'] = str(build_dir)
    env['PATH'] = os.pathsep.join([str(cargo.parent), env.get('PATH', '')])
    PROGRESS.emit(DEP_ID, 'installing', message=f'Building gdls {tag} from source with cargo…')
    run_streaming(
        [
            str(cargo),
            'install',
            '--git',
            REPO_URL,
            '--tag',
            tag,
            '--locked',
            '--root',
            str(staging),
            '--bin',
            'gdls',
            'gd_server',
        ],
        dep_id=DEP_ID,
        label='cargo install gdls',
        timeout=COMPILE_TIMEOUT_S,
        env=env,
    )
    found = staging / 'bin' / _binary_name()
    if not found.is_file():
        raise RuntimeError(f'cargo install finished without producing {found}.')
    PROGRESS.emit(DEP_ID, 'finishing', message='Checking the installed binary…')
    _place_binary(found, staging, tag)
    shutil.rmtree(build_dir, ignore_errors=True)


def _stop_running_servers() -> None:
    """Stop running gdls processes: on Windows an executable can't be replaced while it runs.

    A running server belongs to the backend process; the Electron bootstrap CLI has none to stop.
    """

    try:
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions

        shutdown_lsp_server_for_all_sessions('gdscript')
    except Exception as exc:
        logger.warning('could not stop running gdls servers: %s', exc)


@contextmanager
def _servers_held_off() -> Iterator[None]:
    """Stop gdls and keep it stopped until the install on disk has finished changing.

    The editor keeps sending LSP requests during a download; any of them would otherwise restart
    the old binary and lock it again. Requests in this window report gdls as not installed, and the
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
    raise RuntimeError(f'Could not remove {path}. A gdls process may still be using it.')


def install(*, force: bool = False) -> dict:
    tag = target_tag()
    target = _version_dir(tag)
    if not force and _is_ready(target) and read_ready_marker(target) == tag:
        logger.info('gdls already installed path=%s', target)
        PROGRESS.emit(DEP_ID, 'done', message='Already installed')
        return status()

    logger.info('install gdls tag=%s force=%s', tag, force)
    raise_if_cancelled()
    get_runtime_gdls_dir().mkdir(parents=True, exist_ok=True)
    lock_path = get_runtime_downloads_dir() / 'gdls.lock'

    def _ready() -> bool:
        return not force and _is_ready(target)

    with _servers_held_off(), with_download_lock(lock_path, ready_check=_ready) as lock:
        if lock.held:
            asset = prebuilt_asset_name(tag)
            if asset is not None:
                _install_prebuilt(tag, asset)
            else:
                _install_with_cargo(tag)
            _remove_other_versions(keep=tag)

    logger.info('gdls ready path=%s', target)
    PROGRESS.emit(DEP_ID, 'done', message=f'gdls {tag} ready')
    return status()


def _remove_other_versions(*, keep: str) -> None:
    root = get_runtime_gdls_dir()
    for entry in root.iterdir():
        if entry.is_dir() and entry.name != keep and _TAG_RE.match(entry.name):
            shutil.rmtree(entry, ignore_errors=True)


def delete() -> dict:
    root = get_runtime_gdls_dir()
    logger.info('delete gdls root=%s', root)
    with _servers_held_off():
        if root.exists():
            _remove_tree(root)
        cleanup_partial()
    PROGRESS.emit(DEP_ID, 'done', message='gdls removed')
    return status()


def cleanup_partial() -> None:
    """Remove what a cancelled install leaves: archives, build trees and staging directories."""

    downloads = get_runtime_downloads_dir()
    if downloads.is_dir():
        for entry in downloads.iterdir():
            if not entry.name.startswith('gdls-'):
                continue
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)
    root = get_runtime_gdls_dir()
    if root.is_dir():
        for entry in root.iterdir():
            if entry.is_dir() and entry.name.startswith(_STAGING_PREFIX):
                shutil.rmtree(entry, ignore_errors=True)
