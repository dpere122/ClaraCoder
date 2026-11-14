"""Install vtsls (https://github.com/yioneko/vtsls), the TypeScript / JavaScript language server.

vtsls is plain JavaScript and runs on the Electron binary in Node mode, so nothing is built and
neither Node nor npm is needed. The install fetches the pinned npm package tarballs straight from
the registry, checks each against its pinned sha512 integrity, and lays them out as the
``node_modules`` tree ``npm install`` would produce. Each version lives in its own
``<runtime>/vtsls/<version>/`` directory with its own ready marker.

Only the pinned tree is installed: the pins below come from the ``package-lock.json`` of
``npm install @vtsls/language-server@<DEFAULT_TAG>``. ``CLARA_TYPESCRIPT_LSP_COMMAND`` runs another build.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import shutil
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from clara_coder_backend.runtime.deps.cancel import raise_if_cancelled
from clara_coder_backend.runtime.deps.download import (
    download_file,
    extract_archive,
    read_ready_marker,
    with_download_lock,
    write_ready_marker,
)
from clara_coder_backend.runtime.deps.paths import get_runtime_downloads_dir, get_runtime_vtsls_dir
from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.vtsls')

DEP_ID = 'vtsls'
LABEL = 'TypeScript/JS LSP (vtsls)'
DESCRIPTION = 'TypeScript and JavaScript language server, with its own TypeScript 5.9. Runs on the Node built into Clara.'
SIZE_HINT = '~25 MB'

REPO_URL = 'https://github.com/yioneko/vtsls'
#: Version of ``@vtsls/language-server``; it pins the TypeScript it runs (5.9.3 for 0.3.0).
DEFAULT_TAG = '0.3.0'
# Every package of the ``DEFAULT_TAG`` tree: (path in the install, tarball URL, npm integrity).
# Copied from the lockfile of ``npm install @vtsls/language-server@0.3.0``. Update with the tag.
_PINNED_PACKAGES: tuple[tuple[str, str, str], ...] = (
    (
        'node_modules/@vscode/l10n',
        'https://registry.npmjs.org/@vscode/l10n/-/l10n-0.0.18.tgz',
        'sha512-KYSIHVmslkaCDyw013pphY+d7x1qV8IZupYfeIfzNA+nsaWHbn5uPuQRvdRFsa9zFzGeudPuoGoZ1Op4jrJXIQ==',
    ),
    (
        'node_modules/@vtsls/language-server',
        'https://registry.npmjs.org/@vtsls/language-server/-/language-server-0.3.0.tgz',
        'sha512-EYTkCHNGz3MFSP7z0DZ5+WBQY5CWEH7bCUu53EaDloBTjghoi2vfZqSrS0+7WsRG03MhBhjGG9ifNee/2kixvQ==',
    ),
    (
        'node_modules/@vtsls/language-service',
        'https://registry.npmjs.org/@vtsls/language-service/-/language-service-0.3.0.tgz',
        'sha512-u2Z5oY64953CvG1SdI6Zimlbnaqj7OT/sj9zcw/gr/f6pl3e0ryh8lsa376MeC9T/SW7q+Aw0YMyUZIIIZOyng==',
    ),
    (
        'node_modules/@vtsls/vscode-fuzzy',
        'https://registry.npmjs.org/@vtsls/vscode-fuzzy/-/vscode-fuzzy-0.1.0.tgz',
        'sha512-jpJ6pFyi152BZ65j1D7otCf1YA9xaMqXV6nn2MOF8BNx0mkwIp2lTj26xvGk/mvEtiVvsGN3vMiBNXMxcv6bIA==',
    ),
    (
        'node_modules/jsonc-parser',
        'https://registry.npmjs.org/jsonc-parser/-/jsonc-parser-3.3.1.tgz',
        'sha512-HUgH65KyejrUFPvHFPbqOY0rsFip3Bo5wb4ngvdi1EpCYWUQDC5V+Y7mZws+DLkr4M//zQJoanu1SP+87Dv1oQ==',
    ),
    (
        'node_modules/lru-cache',
        'https://registry.npmjs.org/lru-cache/-/lru-cache-6.0.0.tgz',
        'sha512-Jo6dJ04CmSjuznwJSS3pUeWmd/H0ffTlkXXgwZi+eq1UCmqQwCh+eLsYOYCwY991i2Fah4h1BEMCx4qThGbsiA==',
    ),
    (
        'node_modules/semver',
        'https://registry.npmjs.org/semver/-/semver-7.5.2.tgz',
        'sha512-SoftuTROv/cRjCze/scjGyiDtcUyxw1rgYQSZY7XTmtR5hX+dm76iDbTH8TkLPHCQmlbQVSSbNZCPM2hb0knnQ==',
    ),
    (
        'node_modules/typescript',
        'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz',
        'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==',
    ),
    (
        'node_modules/vscode-jsonrpc',
        'https://registry.npmjs.org/vscode-jsonrpc/-/vscode-jsonrpc-9.0.1.tgz',
        'sha512-rfuA6T75H6m5EkbhtEPzre9pT0HPcDI2MMy4+nPFIBks5J8JBAUHD4tRYSgaBOijIEC7SRkC1kKyXTLqbmh9jw==',
    ),
    (
        'node_modules/vscode-languageserver',
        'https://registry.npmjs.org/vscode-languageserver/-/vscode-languageserver-9.0.1.tgz',
        'sha512-woByF3PDpkHFUreUa7Hos7+pUWdeWMXRd26+ZX2A8cFx6v/JPTtd4/uN0/jB6XQHYaOlHbio03NTHCqrgG5n7g==',
    ),
    (
        'node_modules/vscode-languageserver-protocol',
        'https://registry.npmjs.org/vscode-languageserver-protocol/-/vscode-languageserver-protocol-3.18.2.tgz',
        'sha512-XRyDbT0Pp3sSNti3JmxVEUMySWCSi1hhM+/KUlCy1hV1zmrqpM1OwO12EAki8blhmLuIMpaJrYbo0OzGVfK2Qg==',
    ),
    (
        'node_modules/vscode-languageserver-textdocument',
        'https://registry.npmjs.org/vscode-languageserver-textdocument/-/vscode-languageserver-textdocument-1.0.12.tgz',
        'sha512-cxWNPesCnQCcMPeenjKKsOCKQZ/L6Tv19DTRIGuLWe32lyzWhihGVJ/rcckZXJxfdKCFvRLS3fpBIsV/ZGX4zA==',
    ),
    (
        'node_modules/vscode-languageserver-types',
        'https://registry.npmjs.org/vscode-languageserver-types/-/vscode-languageserver-types-3.18.0.tgz',
        'sha512-8TsGPNMIMiiBdkORgRSvLjuiEIiAFtO+KssmYWxQ+uSVvlf7RjK8YKCOjPzZ+YA04jXEV7+7LvkSmHkhpNS99g==',
    ),
    (
        'node_modules/vscode-languageserver/node_modules/vscode-jsonrpc',
        'https://registry.npmjs.org/vscode-jsonrpc/-/vscode-jsonrpc-8.2.0.tgz',
        'sha512-C+r0eKJUIfiDIfwJhria30+TYWPtuHJXHtI7J0YlOmKAo7ogxP20T0zxB7HZQIFhIyvoBPwWskjxrvAtfjyZfA==',
    ),
    (
        'node_modules/vscode-languageserver/node_modules/vscode-languageserver-protocol',
        'https://registry.npmjs.org/vscode-languageserver-protocol/-/vscode-languageserver-protocol-3.17.5.tgz',
        'sha512-mb1bvRJN8SVznADSGWM9u/b07H7Ecg0I3OgXDuLdn307rl/J3A9YD6/eYOssqhecL27hK1IPZAsaqh00i/Jljg==',
    ),
    (
        'node_modules/vscode-languageserver/node_modules/vscode-languageserver-types',
        'https://registry.npmjs.org/vscode-languageserver-types/-/vscode-languageserver-types-3.17.5.tgz',
        'sha512-Ld1VelNuX9pdF39h2Hgaeb5hEZM2Z3jUrrMgWQAu82jMtZp7p3vJT3BzToKtZI7NgQssZje5o0zryOrhQvzQAg==',
    ),
    (
        'node_modules/vscode-uri',
        'https://registry.npmjs.org/vscode-uri/-/vscode-uri-3.1.0.tgz',
        'sha512-/BpdSx+yCQGnCvecbyXdxHDkuk55/G3xwnC0GqY4gmQ3j+A+g8kzzgB4Nk/SINjqn6+waqw3EgbVF2QKExkRxQ==',
    ),
    (
        'node_modules/yallist',
        'https://registry.npmjs.org/yallist/-/yallist-4.0.0.tgz',
        'sha512-3wdGidZyq5PB084XLES5TpOSRA3wjXAlIWMhum2kRcv/41Sn2emQ0dycQW4uZXLejwKvg6EsvbdlVL+FYEct7A==',
    ),
)
#: The script Electron runs in Node mode, relative to a version directory.
ENTRY_RELATIVE = PurePosixPath('node_modules/@vtsls/language-server/bin/vtsls.js')
_STAGING_PREFIX = '.staging-'
_UNPACK_PREFIX = '.unpack-'
_ARCHIVE_PREFIX = 'vtsls-'
# A stopped server keeps files under its install open on Windows for a moment after it exits.
_REMOVE_ATTEMPTS = 5
_REMOVE_RETRY_S = 0.5

_TAG_RE = re.compile(r'^\d+\.\d+\.\d+$')

# Installs and deletes running in this process; while any runs, no server may start.
_changing_install = 0
_changing_install_lock = threading.Lock()


def _version_dir(tag: str) -> Path:
    return get_runtime_vtsls_dir() / tag


def _entry(version_dir: Path) -> Path:
    return version_dir.joinpath(*ENTRY_RELATIVE.parts)


def _is_ready(version_dir: Path) -> bool:
    return _entry(version_dir).is_file() and read_ready_marker(version_dir) is not None


def _tag_key(tag: str) -> tuple[int, ...]:
    return tuple(int(part) for part in tag.split('.'))


def installed_version_dir() -> Path | None:
    """Directory of the install to run: the pinned version when ready, else the newest ready one.

    An older install keeps TypeScript files working until the user updates it from Dependencies.
    This only looks at the disk, so status and server start never touch the network.
    """

    target = _version_dir(DEFAULT_TAG)
    if _is_ready(target):
        return target
    root = get_runtime_vtsls_dir()
    if not root.is_dir():
        return None
    ready = [entry for entry in root.iterdir() if entry.is_dir() and _TAG_RE.match(entry.name) and _is_ready(entry)]
    return max(ready, key=lambda entry: _tag_key(entry.name)) if ready else None


def installed_binary() -> Path | None:
    """Path of ``vtsls.js`` to run, or None when it is missing or being replaced."""

    with _changing_install_lock:
        if _changing_install:
            return None
    version_dir = installed_version_dir()
    return _entry(version_dir) if version_dir is not None else None


def components() -> list[str]:
    return ['@vtsls/language-server', 'typescript']


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
            'path': str(_entry(version_dir)),
        }
    return {**base, 'version': None, 'state': 'missing', 'path': None}


def _integrity_of(path: Path) -> str:
    """npm ``integrity`` string (``sha512-<base64>``) of the file at ``path``."""

    digest = hashlib.sha512()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return 'sha512-' + base64.b64encode(digest.digest()).decode('ascii')


def _package_name(install_path: str) -> str:
    """``node_modules/a/node_modules/@b/c`` -> ``@b/c``."""

    return install_path.rsplit('node_modules/', 1)[-1]


def _place_package(archive: Path, unpack: Path, dest: Path) -> None:
    """Unpack the npm tarball ``archive`` and move its single root folder to ``dest``.

    npm tarballs keep their files under one folder, nearly always ``package/``.
    """

    extract_archive(archive, unpack)
    roots = list(unpack.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        names = ', '.join(sorted(p.name for p in roots)) or 'nothing'
        raise RuntimeError(f'{archive.name} does not hold a single package folder (found: {names}).')
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(roots[0]), str(dest))
    _remove_tree(unpack)


def _install_packages(tag: str) -> None:
    downloads = get_runtime_downloads_dir()
    downloads.mkdir(parents=True, exist_ok=True)
    root = get_runtime_vtsls_dir()
    staging = root / f'{_STAGING_PREFIX}{tag}'
    unpack = root / f'{_UNPACK_PREFIX}{tag}'
    if staging.exists():
        _remove_tree(staging)
    staging.mkdir(parents=True)
    # A parent package first, so a nested ``…/node_modules/x`` lands inside it.
    packages = sorted(_PINNED_PACKAGES, key=lambda pin: pin[0].count('/node_modules/'))
    try:
        for index, (install_path, url, expected) in enumerate(packages, start=1):
            raise_if_cancelled()
            name = _package_name(install_path)
            archive = downloads / f'{_ARCHIVE_PREFIX}{index:02d}-{url.rsplit("/", 1)[-1]}'
            message = f'Downloading {name} ({index}/{len(packages)})…'
            PROGRESS.emit(DEP_ID, 'downloading', message=message)

            def _progress(done: int, total: int | None, message: str = message) -> None:
                PROGRESS.emit(DEP_ID, 'downloading', bytes_done=done, bytes_total=total, message=message)

            download_file(url, archive, on_progress=_progress, timeout=300)
            actual = _integrity_of(archive)
            if actual != expected:
                archive.unlink(missing_ok=True)
                raise RuntimeError(
                    f'Checksum mismatch for {name}: expected {expected}, got {actual}. Nothing was installed.'
                )
            PROGRESS.emit(DEP_ID, 'extracting', message=f'Unpacking {name}…')
            _place_package(archive, unpack, staging.joinpath(*PurePosixPath(install_path).parts))
            archive.unlink(missing_ok=True)

        PROGRESS.emit(DEP_ID, 'finishing', message='Checking the installed files…')
        if not _entry(staging).is_file():
            raise RuntimeError(f'{ENTRY_RELATIVE} is missing from the downloaded packages.')
        write_ready_marker(staging, tag)
        target = _version_dir(tag)
        if target.exists():
            _remove_tree(target)
        staging.replace(target)
    except BaseException:
        # Nothing half-written stays behind; a cancel also runs cleanup_partial().
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(unpack, ignore_errors=True)
        _remove_archives()
        raise


def _stop_running_servers() -> None:
    """Stop running vtsls processes: on Windows their open files block replacing the install.

    A running server belongs to the backend process; the Electron bootstrap CLI has none to stop.
    """

    try:
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions

        shutdown_lsp_server_for_all_sessions('typescript')
    except Exception as exc:
        logger.warning('could not stop running vtsls servers: %s', exc)


@contextmanager
def _servers_held_off() -> Iterator[None]:
    """Stop vtsls and keep it stopped until the install on disk has finished changing.

    The editor keeps sending LSP requests during a download; any of them would otherwise restart
    the old install and lock it again. Requests in this window report it as not installed, and the
    next one after it starts the new install.
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
    raise RuntimeError(f'Could not remove {path}. A vtsls process may still be using it.')


def install(*, force: bool = False) -> dict:
    tag = DEFAULT_TAG
    target = _version_dir(tag)
    if not force and _is_ready(target) and read_ready_marker(target) == tag:
        logger.info('vtsls already installed path=%s', target)
        PROGRESS.emit(DEP_ID, 'done', message='Already installed')
        return status()

    logger.info('install vtsls tag=%s packages=%d force=%s', tag, len(_PINNED_PACKAGES), force)
    raise_if_cancelled()
    get_runtime_vtsls_dir().mkdir(parents=True, exist_ok=True)
    lock_path = get_runtime_downloads_dir() / 'vtsls.lock'

    def _ready() -> bool:
        return not force and _is_ready(target)

    with _servers_held_off(), with_download_lock(lock_path, ready_check=_ready) as lock:
        if lock.held:
            _install_packages(tag)
            _remove_other_versions(keep=tag)

    logger.info('vtsls ready path=%s', target)
    PROGRESS.emit(DEP_ID, 'done', message=f'vtsls {tag} ready')
    return status()


def _remove_other_versions(*, keep: str) -> None:
    for entry in get_runtime_vtsls_dir().iterdir():
        if entry.is_dir() and entry.name != keep and _TAG_RE.match(entry.name):
            shutil.rmtree(entry, ignore_errors=True)


def delete() -> dict:
    root = get_runtime_vtsls_dir()
    logger.info('delete vtsls root=%s', root)
    with _servers_held_off():
        if root.exists():
            _remove_tree(root)
        cleanup_partial()
    PROGRESS.emit(DEP_ID, 'done', message='vtsls removed')
    return status()


def _remove_archives() -> None:
    downloads = get_runtime_downloads_dir()
    if downloads.is_dir():
        for entry in downloads.iterdir():
            if entry.is_file() and entry.name.startswith(_ARCHIVE_PREFIX):
                entry.unlink(missing_ok=True)


def cleanup_partial() -> None:
    """Remove what a cancelled install leaves: downloaded tarballs, staging and unpack directories."""

    _remove_archives()
    root = get_runtime_vtsls_dir()
    if root.is_dir():
        for entry in root.iterdir():
            if entry.is_dir() and entry.name.startswith((_STAGING_PREFIX, _UNPACK_PREFIX)):
                shutil.rmtree(entry, ignore_errors=True)
