"""Spawn command for Eclipse JDT Language Server (JDK launch)."""

from __future__ import annotations

from clara_coder_backend.config import env_clara
from clara_coder_backend.domain import RuntimeJavaLspConfig
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


def _java_lsp_settings() -> RuntimeJavaLspConfig:
    # Imported here: ``session.state`` pulls in most of the backend.
    from clara_coder_backend.session.state import runtime_config

    return runtime_config.lsp.java


def _java_binary_in(home: Path) -> Path:
    return home / 'bin' / ('java.exe' if os.name == 'nt' else 'java')


def _configured_java_executable(jdk_home: str) -> Path:
    """The JDK chosen in Settings. A wrong folder is an error: quietly running another JDK would hide it."""

    try:
        java_bin = _java_binary_in(Path(jdk_home).expanduser())
    except RuntimeError as exc:  # ``~name`` for a user who doesn't exist
        raise JavaLspSetupError(f'Could not find JDK folder {jdk_home}. Check JDK folder in Settings → LSP → Java.') from exc
    if not java_bin.is_file():
        raise JavaLspSetupError(f'No Java executable at {java_bin}. Check JDK folder in Settings → LSP → Java.')
    major = _java_major_version(java_bin)
    if major is None:
        raise JavaLspSetupError(f'Could not read the Java version of {java_bin}. Check JDK folder in Settings → LSP → Java.')
    if major < _MIN_JAVA_MAJOR:
        raise JavaLspSetupError(
            f'Java LSP requires JDK {_MIN_JAVA_MAJOR}+ to run Eclipse JDT LS; found major version {major} '
            f'at {java_bin}. Choose a newer JDK folder in Settings → LSP → Java.'
        )
    logger.info('java LSP using JDK from settings major=%s path=%s', major, java_bin)
    return java_bin.resolve()


def resolve_java_executable() -> Path:
    """Return a JDK ``java`` binary, requiring major version >= 21.

    Looks at Settings → LSP → Java, then ``JAVA_HOME``, then ``java`` on ``PATH``.
    """

    jdk_home = _java_lsp_settings().jdk_home.strip()
    if jdk_home:
        return _configured_java_executable(jdk_home)

    candidates: list[Path] = []
    java_home = os.environ.get('JAVA_HOME', '').strip()
    if java_home:
        candidates.append(_java_binary_in(Path(java_home).expanduser()))
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
                f'found major version {major} at {cand}. Set JAVA_HOME to a newer JDK, '
                'or choose one in Settings → LSP → Java.'
            )
        logger.info('java LSP using JDK major=%s path=%s', major, cand)
        return cand.resolve()

    raise JavaLspSetupError(
        f'Java LSP requires a JDK {_MIN_JAVA_MAJOR}+ (JAVA_HOME or java on PATH). '
        'Install a JDK and restart Clara, choose one in Settings → LSP → Java, '
        'or set CLARA_JAVA_LSP_COMMAND to a custom stdio server.'
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


def _project_hash(project_root: Path, instance_key: str = '') -> str:
    raw = '\0'.join([str(project_root.resolve()), (instance_key or '').strip()])
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:24]


def _key_with_data_settings(instance_key: str, s: RuntimeJavaLspConfig, *, loose_folder: bool) -> str:
    """Settings JDT LS can't undo in an existing ``-data``, so each value gets its own.

    It keeps a project it has even with import off, and a default JDK even after it's gone from the list.
    """

    off = [f'no-{tool}' for tool, on in (('maven', s.import_maven), ('gradle', s.import_gradle)) if not on]
    default_jdk = [f'default-jdk={s.runtimes[0][1]}'] if loose_folder and s.runtimes else []
    return ':'.join([instance_key, *off, *default_jdk])


def _instance_config_dir(project_root: Path, instance_key: str = '') -> Path:
    """Empty writable Equinox configuration area (cascaded from the product config)."""

    path = get_java_lsp_cache_dir() / 'config-area' / _project_hash(project_root, instance_key)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _workspace_data_dir(project_root: Path, instance_key: str = '') -> Path:
    path = get_java_lsp_cache_dir() / 'workspace-data' / _project_hash(project_root, instance_key)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _formatter_settings_url(path: str) -> str:
    """``java.format.settings.url`` takes a URI or a path relative to the project, not a Windows path."""

    try:
        candidate = Path(path).expanduser()
    except RuntimeError:  # ``~name`` for a user who doesn't exist: an optional setting mustn't stop the server.
        return path
    return candidate.as_uri() if candidate.is_absolute() else path


def _check_project_jdks(runtimes: list[tuple[str, str]]) -> None:
    """JDT LS skips a Project JDK it can't use and compiles against another without saying so."""

    for name, path in runtimes:
        java_bin = _java_binary_in(Path(path))
        if not java_bin.is_file():
            raise JavaLspSetupError(f'No Java executable at {java_bin} for {name}. Check Project JDKs in Settings → LSP → Java.')


def _user_java_settings(s: RuntimeJavaLspConfig, *, loose_folder: bool) -> dict:
    """``settings.java`` from Settings → LSP → Java. Optional paths are left out while they're empty."""

    configuration: dict = {'updateBuildConfiguration': s.update_build_configuration}
    if s.maven_user_settings:
        configuration['maven'] = {'userSettings': s.maven_user_settings}
    if s.runtimes:
        # Only a loose folder gets a default: with one, a Gradle project without a Java version
        # compiles against it, and Gradle itself runs on it.
        configuration['runtimes'] = [
            {'name': name, 'path': path, **({'default': True} if loose_folder and index == 0 else {})}
            for index, (name, path) in enumerate(s.runtimes)
        ]
    formatter: dict = {
        'enabled': s.format_enabled,
        'onType': {'enabled': s.format_on_type},
        'comments': {'enabled': s.format_comments},
    }
    formatter_settings = {
        **({'url': _formatter_settings_url(s.formatter_settings_path)} if s.formatter_settings_path else {}),
        **({'profile': s.formatter_profile} if s.formatter_profile else {}),
    }
    if formatter_settings:
        formatter['settings'] = formatter_settings
    return {
        'autobuild': {'enabled': s.autobuild},
        'configuration': configuration,
        'import': {
            'gradle': {'enabled': s.import_gradle},
            'maven': {'enabled': s.import_maven},
        },
        'inlayHints': {
            'parameterNames': {'enabled': s.inlay_parameter_names},
            'variableTypes': {'enabled': s.inlay_variable_types},
            'parameterTypes': {'enabled': s.inlay_parameter_types},
            'formatParameters': {'enabled': s.inlay_format_parameters},
        },
        'referencesCodeLens': {'enabled': s.references_code_lens},
        'implementationCodeLens': s.implementation_code_lens,
        'signatureHelp': {'enabled': s.signature_help},
        'completion': {'guessMethodArguments': s.guess_method_arguments},
        'format': formatter,
    }


def build_java_initialization_options(
    java_settings: dict | None = None,
    *,
    settings: RuntimeJavaLspConfig | None = None,
    loose_folder: bool = False,
) -> dict:
    """JDT LS ``initializationOptions`` from Settings → LSP → Java (``settings`` overrides them).

    ``java_settings`` (loose folders only, see ``java_loose_folder.java_loose_settings``)
    adds ``java.project.*`` and ``java.configuration.runtimes``, and a project's own
    ``.clara/java.json`` wins over Settings. Build-tool projects pass nothing so their
    classpath stays owned by Maven/Gradle; they pick from Settings' Project JDKs by Java version.
    """

    java: dict = {
        **_user_java_settings(settings if settings is not None else _java_lsp_settings(), loose_folder=loose_folder),
        'server': {
            'launchMode': 'Standard',
        },
    }
    for key, value in (java_settings or {}).items():
        if isinstance(value, dict) and isinstance(java.get(key), dict):
            java[key] = {**java[key], **value}
        else:
            java[key] = value
    return {
        'settings': {
            'java': java,
        },
        'extendedClientCapabilities': {
            'progressReportProvider': False,
            'classFileContentsSupport': False,
            'shouldLanguageServerExitOnShutdown': True,
        },
    }


def build_java_lsp_command(project_root: Path, *, instance_key: str = '', loose_folder: bool = False) -> list[str]:
    """Return argv to run Eclipse JDT LS over stdio for ``project_root``.

    ``CLARA_JAVA_LSP_COMMAND`` may override the default. When unset, uses a JDT LS
    product already installed via Dependencies (does not auto-download).

    ``instance_key`` isolates ``-configuration`` / ``-data`` dirs so two managers
    (session, workspace vs staging) do not share one Equinox workspace. Product
    ``config_linux`` / ``config_mac`` / ``config_win`` is referenced read-only via
    ``osgi.sharedConfiguration.area`` (same as upstream ``jdtls.py``); copying that
    tree into ``-configuration`` breaks ``osgi.framework`` / bundle paths and
    leaves initialize hanging.
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
            'Java LSP (JDT LS) is not installed. Open Dependencies and download '
            '“Java LSP (JDT LS)”, then retry.'
        )
    launcher = _find_equinox_launcher(product_dir)
    if launcher is None:
        raise JavaLspSetupError(f'No Equinox launcher jar under {product_dir / "plugins"}')
    shared_config = _resolve_platform_config_dir(product_dir)
    settings = _java_lsp_settings()
    _check_project_jdks(settings.runtimes)
    instance_key = _key_with_data_settings(instance_key, settings, loose_folder=loose_folder)
    config_dir = _instance_config_dir(root, instance_key)
    data_dir = _workspace_data_dir(root, instance_key)

    cmd = [
        str(java_bin),
        '-Declipse.application=org.eclipse.jdt.ls.core.id1',
        '-Dosgi.bundles.defaultStartLevel=4',
        '-Declipse.product=org.eclipse.jdt.ls.core.product',
        '-Dosgi.checkConfiguration=true',
        f'-Dosgi.sharedConfiguration.area={shared_config}',
        '-Dosgi.sharedConfiguration.area.readOnly=true',
        '-Dosgi.configuration.cascaded=true',
        '-Djava.awt.headless=true',
        '-Dlog.level=ERROR',
        # A system property, not a ``java.*`` setting: JDT LS's filesystem bundle reads it, and unset means true.
        *([] if settings.project_metadata_at_root else ['-Djava.import.generatesMetadataFilesAtProjectRoot=false']),
        f'-Xmx{settings.max_heap}',
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
