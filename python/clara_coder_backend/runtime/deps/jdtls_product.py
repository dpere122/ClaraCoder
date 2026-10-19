"""Eclipse JDT LS product download, cache, and readiness checks (runtime-owned)."""

from __future__ import annotations

from clara_coder_backend.config import env_clara

import logging
import os
import re
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from clara_coder_backend.runtime.deps import cancel as deps_cancel
from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.jdtls_product')

__all__ = [
    'DEFAULT_JDTLS_MILESTONE',
    'JavaLspSetupError',
    'ensure_jdtls_product_dir',
    'get_java_lsp_cache_dir',
    'get_jdtls_product_dir_if_ready',
    'resolve_jdtls_milestone',
]

DEFAULT_JDTLS_MILESTONE = '1.60.0'
_MILESTONES_BASE = 'https://download.eclipse.org/jdtls/milestones'
_VERSION_DIR_RE = re.compile(r'href=["\']?(\d+\.\d+\.\d+)/["\']?', re.IGNORECASE)
_LAUNCHER_GLOB = 'org.eclipse.equinox.launcher_*.jar'


class JavaLspSetupError(RuntimeError):
    """Raised when JDT LS product cannot be prepared."""


def get_java_lsp_cache_dir() -> Path:
    """Return the JDT LS cache root (``CLARA_JAVA_LSP_CACHE_DIR`` or runtime/java-lsp)."""

    raw = env_clara('CLARA_JAVA_LSP_CACHE_DIR', '').strip()
    if raw:
        return Path(raw).expanduser().resolve()
    from clara_coder_backend.runtime.deps.paths import get_runtime_java_lsp_dir

    return get_runtime_java_lsp_dir()


def _platform_config_dirname() -> str:
    if sys.platform == 'darwin':
        return 'config_mac'
    if sys.platform.startswith('win'):
        return 'config_win'
    return 'config_linux'


def _parse_version_tuple(version: str) -> tuple[int, ...]:
    parts = []
    for bit in version.split('.'):
        try:
            parts.append(int(bit))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def _discover_latest_milestone() -> str | None:
    try:
        with urllib.request.urlopen(f'{_MILESTONES_BASE}/', timeout=30) as resp:
            body = resp.read().decode('utf-8', errors='replace')
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.warning('jdtls milestone discovery failed: %s', exc)
        return None
    versions = set(_VERSION_DIR_RE.findall(body))
    if not versions:
        return None
    return max(versions, key=_parse_version_tuple)


def resolve_jdtls_milestone() -> str:
    """Return the JDT LS milestone version to install (env pin, discovery, or default)."""

    pinned = env_clara('CLARA_JAVA_LSP_VERSION', '').strip()
    if pinned:
        return pinned.lstrip('v')
    cache = get_java_lsp_cache_dir()
    marker = cache / 'resolved-milestone.txt'
    if marker.is_file():
        cached = marker.read_text(encoding='utf-8').strip()
        if cached:
            return cached
    discovered = _discover_latest_milestone()
    version = discovered or DEFAULT_JDTLS_MILESTONE
    try:
        cache.mkdir(parents=True, exist_ok=True)
        marker.write_text(version + '\n', encoding='utf-8')
    except OSError as exc:
        logger.warning('could not persist jdtls milestone marker: %s', exc)
    return version


def _find_equinox_launcher(product_dir: Path) -> Path | None:
    plugins = product_dir / 'plugins'
    if not plugins.is_dir():
        return None
    matches = sorted(plugins.glob(_LAUNCHER_GLOB))
    return matches[-1] if matches else None


def _resolve_platform_config_dir(product_dir: Path) -> Path:
    preferred = product_dir / _platform_config_dirname()
    if preferred.is_dir():
        return preferred
    if sys.platform == 'darwin':
        for name in ('config_mac_aarch64', 'config_mac_x86_64'):
            alt = product_dir / name
            if alt.is_dir():
                return alt
    raise JavaLspSetupError(
        f'JDT LS product at {product_dir} is missing platform config '
        f'(expected {_platform_config_dirname()}).'
    )


def _product_looks_valid(product_dir: Path) -> bool:
    if _find_equinox_launcher(product_dir) is None:
        return False
    try:
        _resolve_platform_config_dir(product_dir)
    except JavaLspSetupError:
        return False
    return True


def _download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + '.partial')
    # Byte progress / cancel only apply inside a Dependencies-window install of java-lsp;
    # the LSP manager also calls this on demand, where there is nothing to report to.
    reporting = deps_cancel.current() == 'java-lsp'
    try:
        with urllib.request.urlopen(url, timeout=120) as resp, partial.open('wb') as out:
            total_hdr = resp.headers.get('Content-Length')
            total = int(total_hdr) if total_hdr and total_hdr.isdigit() else None
            done = 0
            while True:
                deps_cancel.raise_if_cancelled()
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if reporting:
                    PROGRESS.emit(
                        'java-lsp',
                        'downloading',
                        bytes_done=done,
                        bytes_total=total,
                        message=f'Downloading {dest.name}…',
                    )
        partial.replace(dest)
    except Exception:
        if partial.exists():
            try:
                partial.unlink()
            except OSError:
                pass
        raise


def _fetch_tarball_name(version: str) -> str:
    url = f'{_MILESTONES_BASE}/{version}/latest.txt'
    with urllib.request.urlopen(url, timeout=30) as resp:
        name = resp.read().decode('utf-8', errors='replace').strip().splitlines()[0].strip()
    if not name or not name.endswith('.tar.gz'):
        raise JavaLspSetupError(f'Unexpected JDT LS latest.txt contents for {version}: {name!r}')
    return name


def ensure_jdtls_product_dir(*, force_download: bool = False) -> Path:
    """Ensure a JDT LS product tree exists under the cache and return its root."""

    cache = get_java_lsp_cache_dir()
    version = resolve_jdtls_milestone()
    product_dir = cache / 'jdtls' / version
    ready_marker = product_dir / '.nemo-ready'
    if not force_download and ready_marker.is_file() and _product_looks_valid(product_dir):
        return product_dir

    lock_path = cache / f'.download-{version}.lock'
    cache.mkdir(parents=True, exist_ok=True)
    for _ in range(120):
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except FileExistsError:
            if ready_marker.is_file() and _product_looks_valid(product_dir):
                return product_dir
            time.sleep(0.5)
    else:
        if ready_marker.is_file() and _product_looks_valid(product_dir):
            return product_dir
        raise JavaLspSetupError(f'Timed out waiting for JDT LS download lock at {lock_path}')

    try:
        if not force_download and ready_marker.is_file() and _product_looks_valid(product_dir):
            return product_dir
        if product_dir.exists():
            shutil.rmtree(product_dir, ignore_errors=True)
        product_dir.mkdir(parents=True, exist_ok=True)

        tarball_name = _fetch_tarball_name(version)
        url = f'{_MILESTONES_BASE}/{version}/{tarball_name}'
        tarball_path = cache / 'downloads' / tarball_name
        logger.info('downloading JDT LS version=%s url=%s', version, url)
        _download_file(url, tarball_path)

        extract_tmp = cache / 'downloads' / f'extract-{version}'
        if extract_tmp.exists():
            shutil.rmtree(extract_tmp, ignore_errors=True)
        extract_tmp.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tarball_path, 'r:gz') as tar:
            try:
                tar.extractall(extract_tmp, filter='data')
            except TypeError:
                tar.extractall(extract_tmp)

        candidate = extract_tmp
        if not _product_looks_valid(candidate):
            subdirs = [p for p in extract_tmp.iterdir() if p.is_dir()]
            for sub in subdirs:
                if _product_looks_valid(sub):
                    candidate = sub
                    break
        if not _product_looks_valid(candidate):
            raise JavaLspSetupError(f'Downloaded JDT LS tarball did not contain a valid product: {tarball_path}')

        if candidate.resolve() == extract_tmp.resolve():
            for child in extract_tmp.iterdir():
                shutil.move(str(child), str(product_dir / child.name))
        else:
            for child in candidate.iterdir():
                shutil.move(str(child), str(product_dir / child.name))
        shutil.rmtree(extract_tmp, ignore_errors=True)
        ready_marker.write_text(version + '\n', encoding='utf-8')
        logger.info('JDT LS ready at %s', product_dir)
        return product_dir
    except (urllib.error.URLError, TimeoutError, OSError, tarfile.TarError) as exc:
        raise JavaLspSetupError(f'Failed to download/extract JDT LS {version}: {exc}') from exc
    finally:
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass


def get_jdtls_product_dir_if_ready() -> Path | None:
    """Return a cached JDT LS product when already installed; do not download."""

    cache = get_java_lsp_cache_dir()
    version = resolve_jdtls_milestone()
    product_dir = cache / 'jdtls' / version
    ready_marker = product_dir / '.nemo-ready'
    if ready_marker.is_file() and _product_looks_valid(product_dir):
        return product_dir
    jdtls_root = cache / 'jdtls'
    if jdtls_root.is_dir():
        for child in sorted(jdtls_root.iterdir(), reverse=True):
            if (child / '.nemo-ready').is_file() and _product_looks_valid(child):
                return child
    return None
