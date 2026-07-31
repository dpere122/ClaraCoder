"""Spawn command for Eclipse JDT Language Server (auto-download + JDK launch)."""

from __future__ import annotations

from clara_coder_backend.config import env_clara

import hashlib
import logging
import os
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

logger = logging.getLogger('clara.lsp.java_server')

__all__ = [
    'DEFAULT_JDTLS_MILESTONE',
    'JavaLspSetupError',
    'build_java_initialization_options',
    'build_java_lsp_command',
    'ensure_jdtls_product_dir',
    'get_java_lsp_cache_dir',
    'resolve_java_executable',
]

DEFAULT_JDTLS_MILESTONE = '1.60.0'
_MILESTONES_BASE = 'https://download.eclipse.org/jdtls/milestones'
_MIN_JAVA_MAJOR = 21
_VERSION_DIR_RE = re.compile(r'href=["\']?(\d+\.\d+\.\d+)/["\']?', re.IGNORECASE)
_LAUNCHER_GLOB = 'org.eclipse.equinox.launcher_*.jar'


class JavaLspSetupError(RuntimeError):
    """Raised when JDK or JDT LS cannot be prepared for launch."""


def get_java_lsp_cache_dir() -> Path:
    """Return the JDT LS cache root (``CLARA_JAVA_LSP_CACHE_DIR`` or a temp fallback)."""

    raw = env_clara('CLARA_JAVA_LSP_CACHE_DIR', '').strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path(tempfile.gettempdir()) / 'nemo-java-lsp').resolve()


def resolve_java_executable() -> Path:
    """Return a JDK ``java`` binary (prefers ``JAVA_HOME``), requiring major version >= 21."""

    candidates: list[Path] = []
    java_home = os.environ.get('JAVA_HOME', '').strip()
    if java_home:
        home = Path(java_home).expanduser()
        if os.name == 'nt':
            candidates.append(home / 'bin' / 'java.exe')
        else:
            candidates.append(home / 'bin' / 'java')
    which = shutil.which('java')
    if which:
        candidates.append(Path(which))

    seen: set[str] = set()
    for cand in candidates:
        key = str(cand.resolve()) if cand.exists() else str(cand)
        if key in seen:
            continue
        seen.add(key)
        if not cand.is_file():
            continue
        major = _java_major_version(cand)
        if major is None:
            logger.warning('could not parse java -version for %s', cand)
            continue
        if major < _MIN_JAVA_MAJOR:
            raise JavaLspSetupError(
                f'Java LSP requires JDK {_MIN_JAVA_MAJOR}+ to run Eclipse JDT LS; '
                f'found major version {major} at {cand}. Set JAVA_HOME to a newer JDK.'
            )
        logger.info('java LSP using JDK major=%s path=%s', major, cand)
        return cand.resolve()

    raise JavaLspSetupError(
        f'Java LSP requires a JDK {_MIN_JAVA_MAJOR}+ (JAVA_HOME or java on PATH). '
        'Install a JDK and restart Clara, or set CLARA_JAVA_LSP_COMMAND to a custom stdio server.'
    )


def _java_major_version(java_bin: Path) -> int | None:
    try:
        proc = subprocess.run(
            [str(java_bin), '-version'],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (proc.stderr or '') + '\n' + (proc.stdout or '')
    # Examples: 'openjdk version "21.0.2"' / 'java version "1.8.0_392"'
    m = re.search(r'version\s+"(\d+)(?:\.(\d+))?', text)
    if not m:
        return None
    major = int(m.group(1))
    if major == 1 and m.group(2):
        return int(m.group(2))
    return major


def _platform_config_dirname() -> str:
    if sys.platform == 'darwin':
        # Apple Silicon vs Intel both use config_mac in current JDT LS distros;
        # older builds may ship config_mac_aarch64 — prefer that when present.
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
    try:
        with urllib.request.urlopen(url, timeout=120) as resp, partial.open('wb') as out:
            shutil.copyfileobj(resp, out)
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
    # Best-effort lock: create exclusive lock file; wait briefly if another process holds it.
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
            # ``filter`` is required on newer Python; ignore TypeError on older runtimes.
            try:
                tar.extractall(extract_tmp, filter='data')
            except TypeError:
                tar.extractall(extract_tmp)

        # Tarball usually extracts files directly (plugins/, config_*) into extract_tmp.
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


def _project_hash(project_root: Path) -> str:
    return hashlib.sha256(str(project_root.resolve()).encode('utf-8')).hexdigest()[:24]


def _writable_config_dir(product_dir: Path, project_root: Path) -> Path:
    """Copy the shared platform config into a per-project writable directory."""

    src = _resolve_platform_config_dir(product_dir)
    dest = get_java_lsp_cache_dir() / 'config-work' / _project_hash(project_root)
    if dest.is_dir() and any(dest.iterdir()):
        return dest
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(src, dest)
    return dest


def _workspace_data_dir(project_root: Path) -> Path:
    path = get_java_lsp_cache_dir() / 'workspace-data' / _project_hash(project_root)
    path.mkdir(parents=True, exist_ok=True)
    return path


def build_java_initialization_options() -> dict:
    """Minimal JDT LS ``initializationOptions`` enabling Maven/Gradle import."""

    return {
        'settings': {
            'java': {
                'autobuild': {'enabled': True},
                'configuration': {
                    'updateBuildConfiguration': 'automatic',
                },
                'import': {
                    'gradle': {'enabled': True},
                    'maven': {'enabled': True},
                },
                'server': {
                    'launchMode': 'Standard',
                },
            }
        },
        'extendedClientCapabilities': {
            'progressReportProvider': False,
            'classFileContentsSupport': True,
            'shouldLanguageServerExitOnShutdown': True,
        },
    }


def build_java_lsp_command(project_root: Path) -> list[str]:
    """Return argv to run Eclipse JDT LS over stdio for ``project_root``.

    ``CLARA_JAVA_LSP_COMMAND`` may override the default (skips download). When unset,
    Nemo ensures a cached JDT LS product and launches it with the host JDK.
    """

    root = Path(project_root).resolve()
    raw = env_clara('CLARA_JAVA_LSP_COMMAND', '').strip()
    if raw:
        cmd = shlex.split(raw, posix=os.name != 'nt')
        logger.info('java LSP command override project=%s command=%s', root, cmd)
        return cmd

    java_bin = resolve_java_executable()
    product_dir = ensure_jdtls_product_dir()
    launcher = _find_equinox_launcher(product_dir)
    if launcher is None:
        raise JavaLspSetupError(f'No Equinox launcher jar under {product_dir / "plugins"}')
    config_dir = _writable_config_dir(product_dir, root)
    data_dir = _workspace_data_dir(root)

    cmd = [
        str(java_bin),
        '-Declipse.application=org.eclipse.jdt.ls.core.id1',
        '-Dosgi.bundles.defaultStartLevel=4',
        '-Declipse.product=org.eclipse.jdt.ls.core.product',
        '-Dlog.level=ERROR',
        '-Xmx1G',
        '--add-modules=ALL-SYSTEM',
        '--add-opens',
        'java.base/java.util=ALL-UNNAMED',
        '--add-opens',
        'java.base/java.lang=ALL-UNNAMED',
        '-jar',
        str(launcher),
        '-configuration',
        str(config_dir),
        '-data',
        str(data_dir),
    ]
    logger.info('java LSP command project=%s command=%s', root, cmd)
    return cmd
