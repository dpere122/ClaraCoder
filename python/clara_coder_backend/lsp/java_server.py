"""Spawn command for Eclipse JDT Language Server (JDK launch)."""

from __future__ import annotations

from clara_coder_backend.config import env_clara
from clara_coder_backend.runtime.deps.jdtls_product import (
    DEFAULT_JDTLS_MILESTONE,
    JavaLspSetupError,
    _find_equinox_launcher,
    _resolve_platform_config_dir,
    ensure_jdtls_product_dir,
    get_java_lsp_cache_dir,
    get_jdtls_product_dir_if_ready,
)

import hashlib
import logging
import os
import re
import shutil
import shlex
import subprocess
from pathlib import Path

logger = logging.getLogger('clara.lsp.java_server')

__all__ = [
    'DEFAULT_JDTLS_MILESTONE',
    'JavaLspSetupError',
    'build_java_initialization_options',
    'build_java_lsp_command',
    'ensure_jdtls_product_dir',
    'get_java_lsp_cache_dir',
    'get_jdtls_product_dir_if_ready',
    'resolve_java_executable',
]

_MIN_JAVA_MAJOR = 21


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
    m = re.search(r'version\s+"(\d+)(?:\.(\d+))?', text)
    if not m:
        return None
    major = int(m.group(1))
    if major == 1 and m.group(2):
        return int(m.group(2))
    return major


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

    ``CLARA_JAVA_LSP_COMMAND`` may override the default. When unset, uses a JDT LS
    product already installed via File → Dependencies (does not auto-download).
    """

    root = Path(project_root).resolve()
    raw = env_clara('CLARA_JAVA_LSP_COMMAND', '').strip()
    if raw:
        cmd = shlex.split(raw, posix=os.name != 'nt')
        logger.info('java LSP command override project=%s command=%s', root, cmd)
        return cmd

    java_bin = resolve_java_executable()
    product_dir = get_jdtls_product_dir_if_ready()
    if product_dir is None:
        raise JavaLspSetupError(
            'Java LSP (JDT LS) is not installed. Open File → Dependencies and download '
            '“Java LSP (JDT LS)”, then retry.'
        )
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
    logger.info(
        'java LSP starting from installed product dir=%s project=%s',
        product_dir,
        root,
    )
    return cmd
