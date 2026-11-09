"""Tests for Eclipse JDT LS spawn command resolution."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from clara_coder_backend.domain import RuntimeJavaLspConfig
from clara_coder_backend.lsp import java_server
from clara_coder_backend.lsp.java_server import (
    JavaLspSetupError,
    build_java_initialization_options,
    build_java_lsp_command,
    get_java_lsp_cache_dir,
    resolve_java_executable,
)
from clara_coder_backend.runtime.deps import jdtls_product


def test_build_java_lsp_command_env_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_JAVA_LSP_COMMAND', 'custom_jdtls --stdio')
    cmd = build_java_lsp_command(tmp_path)
    assert cmd == ['custom_jdtls', '--stdio']


def test_get_java_lsp_cache_dir_from_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / 'cache'
    monkeypatch.setenv('CLARA_JAVA_LSP_CACHE_DIR', str(cache))
    assert get_java_lsp_cache_dir() == cache.resolve()


def test_get_java_lsp_cache_dir_defaults_to_runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_CACHE_DIR', raising=False)
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(tmp_path / 'runtime'))
    assert get_java_lsp_cache_dir() == (tmp_path / 'runtime' / 'java-lsp').resolve()


def test_build_java_lsp_command_uses_cached_product(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_COMMAND', raising=False)
    cache = tmp_path / 'java-lsp'
    monkeypatch.setenv('CLARA_JAVA_LSP_CACHE_DIR', str(cache))
    monkeypatch.setenv('CLARA_JAVA_LSP_VERSION', '1.60.0')

    product = cache / 'jdtls' / '1.60.0'
    plugins = product / 'plugins'
    config = product / 'config_linux'
    plugins.mkdir(parents=True)
    config.mkdir(parents=True)
    launcher = plugins / 'org.eclipse.equinox.launcher_1.6.900.v20240613-2000.jar'
    launcher.write_bytes(b'jar')
    (product / '.nemo-ready').write_text('1.60.0\n', encoding='utf-8')

    fake_java = tmp_path / 'jdk' / 'bin' / 'java'
    fake_java.parent.mkdir(parents=True)
    fake_java.write_text('#!/bin/sh\n', encoding='utf-8')
    fake_java.chmod(0o755)

    monkeypatch.setattr(java_server, 'resolve_java_executable', lambda: fake_java.resolve())
    monkeypatch.setattr(jdtls_product, '_platform_config_dirname', lambda: 'config_linux')

    project = tmp_path / 'proj'
    project.mkdir()
    (project / 'pom.xml').write_text('<project/>\n', encoding='utf-8')

    cmd = build_java_lsp_command(project)
    assert cmd[0] == str(fake_java.resolve())
    assert '-jar' in cmd
    assert str(launcher) in cmd
    assert '-configuration' in cmd
    assert '-data' in cmd
    assert '-Dosgi.checkConfiguration=true' in cmd
    assert '-Dosgi.configuration.cascaded=true' in cmd
    assert f'-Dosgi.sharedConfiguration.area={config.resolve()}' in cmd
    data_idx = cmd.index('-data')
    assert Path(cmd[data_idx + 1]).is_dir()
    cfg_idx = cmd.index('-configuration')
    writable_cfg = Path(cmd[cfg_idx + 1])
    assert writable_cfg.is_dir()
    assert writable_cfg.resolve() != config.resolve()


def test_build_java_lsp_command_isolates_data_dirs_by_instance_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_COMMAND', raising=False)
    cache = tmp_path / 'java-lsp'
    monkeypatch.setenv('CLARA_JAVA_LSP_CACHE_DIR', str(cache))
    monkeypatch.setenv('CLARA_JAVA_LSP_VERSION', '1.60.0')

    product = cache / 'jdtls' / '1.60.0'
    plugins = product / 'plugins'
    config = product / 'config_linux'
    plugins.mkdir(parents=True)
    config.mkdir(parents=True)
    launcher = plugins / 'org.eclipse.equinox.launcher_1.6.900.v20240613-2000.jar'
    launcher.write_bytes(b'jar')
    (product / '.nemo-ready').write_text('1.60.0\n', encoding='utf-8')

    fake_java = tmp_path / 'jdk' / 'bin' / 'java'
    fake_java.parent.mkdir(parents=True)
    fake_java.write_text('#!/bin/sh\n', encoding='utf-8')
    fake_java.chmod(0o755)

    monkeypatch.setattr(java_server, 'resolve_java_executable', lambda: fake_java.resolve())
    monkeypatch.setattr(jdtls_product, '_platform_config_dirname', lambda: 'config_linux')

    project = tmp_path / 'proj'
    project.mkdir()
    (project / 'pom.xml').write_text('<project/>\n', encoding='utf-8')

    cmd_workspace = build_java_lsp_command(project, instance_key='sess-a:workspace')
    cmd_staging = build_java_lsp_command(project, instance_key='sess-a:staging')
    cmd_default = build_java_lsp_command(project)

    def _flag_path(cmd: list[str], flag: str) -> Path:
        return Path(cmd[cmd.index(flag) + 1])

    data_workspace = _flag_path(cmd_workspace, '-data')
    data_staging = _flag_path(cmd_staging, '-data')
    data_default = _flag_path(cmd_default, '-data')
    assert data_workspace != data_staging
    assert data_workspace != data_default
    assert data_staging != data_default
    assert data_workspace.is_dir()
    assert data_staging.is_dir()

    cfg_workspace = _flag_path(cmd_workspace, '-configuration')
    cfg_staging = _flag_path(cmd_staging, '-configuration')
    assert cfg_workspace != cfg_staging
    assert cfg_workspace.is_dir()
    assert cfg_staging.is_dir()


def test_build_java_lsp_command_missing_jdk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_COMMAND', raising=False)
    monkeypatch.setenv('CLARA_JAVA_LSP_CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setenv('CLARA_JAVA_LSP_VERSION', '1.60.0')
    monkeypatch.delenv('JAVA_HOME', raising=False)
    monkeypatch.setattr(java_server.shutil, 'which', lambda _name: None)

    # Product present so the failure is the JDK check, not "not installed".
    product = tmp_path / 'cache' / 'jdtls' / '1.60.0'
    plugins = product / 'plugins'
    config = product / 'config_linux'
    plugins.mkdir(parents=True)
    config.mkdir(parents=True)
    (plugins / 'org.eclipse.equinox.launcher_1.6.900.v20240613-2000.jar').write_bytes(b'jar')
    (product / '.nemo-ready').write_text('1.60.0\n', encoding='utf-8')
    monkeypatch.setattr(jdtls_product, '_platform_config_dirname', lambda: 'config_linux')

    with pytest.raises(JavaLspSetupError, match='JDK 21'):
        build_java_lsp_command(tmp_path)


def test_build_java_lsp_command_missing_product(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_COMMAND', raising=False)
    monkeypatch.setenv('CLARA_JAVA_LSP_CACHE_DIR', str(tmp_path / 'cache'))
    fake_java = tmp_path / 'jdk' / 'bin' / 'java'
    fake_java.parent.mkdir(parents=True)
    fake_java.write_text('#!/bin/sh\n', encoding='utf-8')
    fake_java.chmod(0o755)
    monkeypatch.setattr(java_server, 'resolve_java_executable', lambda: fake_java.resolve())

    with pytest.raises(JavaLspSetupError, match='Dependencies'):
        build_java_lsp_command(tmp_path)


def test_build_java_initialization_options_enable_import() -> None:
    opts = build_java_initialization_options()
    java = opts['settings']['java']
    assert java['import']['maven']['enabled'] is True
    assert java['import']['gradle']['enabled'] is True
    assert opts['extendedClientCapabilities']['classFileContentsSupport'] is False


def test_java_options_default_to_what_clara_sent_before_with_signature_help_on() -> None:
    java = build_java_initialization_options(settings=RuntimeJavaLspConfig())['settings']['java']
    assert java['autobuild'] == {'enabled': True}
    assert java['configuration'] == {'updateBuildConfiguration': 'automatic'}
    assert java['import'] == {'gradle': {'enabled': True}, 'maven': {'enabled': True}}
    assert java['server'] == {'launchMode': 'Standard'}
    # JDT LS's own defaults, spelled out; a value JDT LS doesn't know silently falls back to its default.
    assert java['inlayHints']['parameterNames'] == {'enabled': 'literals'}
    assert java['referencesCodeLens'] == {'enabled': True}
    assert java['implementationCodeLens'] == 'none'
    assert java['signatureHelp'] == {'enabled': True}, 'JDT LS leaves this off; Clara turns it on'
    assert java['completion'] == {'guessMethodArguments': 'insertParameterNames'}
    assert java['format'] == {'enabled': True, 'onType': {'enabled': False}, 'comments': {'enabled': True}}


def test_java_options_carry_settings_at_the_keys_jdt_ls_reads(tmp_path: Path) -> None:
    formatter = tmp_path / 'my style.xml'
    java = build_java_initialization_options(
        settings=RuntimeJavaLspConfig(
            runtimes=[('JavaSE-17', 'C:/jdk-17'), ('JavaSE-21', 'C:/jdk-21')],
            import_maven=False,
            import_gradle=False,
            maven_user_settings='C:/m2/settings.xml',
            update_build_configuration='disabled',
            autobuild=False,
            inlay_parameter_names='all',
            inlay_variable_types=True,
            inlay_parameter_types=True,
            inlay_format_parameters=True,
            references_code_lens=False,
            implementation_code_lens='methods',
            signature_help=False,
            guess_method_arguments='insertBestGuessedArguments',
            format_enabled=False,
            format_on_type=True,
            format_comments=False,
            formatter_settings_path=str(formatter),
            formatter_profile='Team',
        )
    )['settings']['java']
    assert java['autobuild'] == {'enabled': False}
    assert java['configuration'] == {
        'updateBuildConfiguration': 'disabled',
        'maven': {'userSettings': 'C:/m2/settings.xml'},
        'runtimes': [
            {'name': 'JavaSE-17', 'path': 'C:/jdk-17', 'default': True},
            {'name': 'JavaSE-21', 'path': 'C:/jdk-21'},
        ],
    }
    assert java['import'] == {'gradle': {'enabled': False}, 'maven': {'enabled': False}}
    assert java['inlayHints'] == {
        'parameterNames': {'enabled': 'all'},
        'variableTypes': {'enabled': True},
        'parameterTypes': {'enabled': True},
        'formatParameters': {'enabled': True},
    }
    assert java['referencesCodeLens'] == {'enabled': False}
    assert java['implementationCodeLens'] == 'methods'
    assert java['signatureHelp'] == {'enabled': False}
    assert java['completion'] == {'guessMethodArguments': 'insertBestGuessedArguments'}
    assert java['format'] == {
        'enabled': False,
        'onType': {'enabled': True},
        'comments': {'enabled': False},
        'settings': {'url': formatter.as_uri(), 'profile': 'Team'},
    }


def test_java_formatter_setting_keeps_a_relative_path_or_url_as_written() -> None:
    for value in ('.settings/style.xml', 'https://example.com/style.xml'):
        java = build_java_initialization_options(
            settings=RuntimeJavaLspConfig(formatter_settings_path=value),
        )['settings']['java']
        assert java['format']['settings'] == {'url': value}


def test_loose_folder_config_wins_over_settings_and_keeps_the_rest() -> None:
    java = build_java_initialization_options(
        {
            'project': {'sourcePaths': ['src']},
            'configuration': {'runtimes': [{'name': 'JavaSE-21', 'path': 'C:/project-jdk'}]},
        },
        settings=RuntimeJavaLspConfig(
            runtimes=[('JavaSE-17', 'C:/settings-jdk')],
            update_build_configuration='disabled',
        ),
    )['settings']['java']
    assert java['project'] == {'sourcePaths': ['src']}
    assert java['configuration'] == {
        'updateBuildConfiguration': 'disabled',
        'runtimes': [{'name': 'JavaSE-21', 'path': 'C:/project-jdk'}],
    }


def _installed_product(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_JAVA_LSP_COMMAND', raising=False)
    monkeypatch.setenv('CLARA_JAVA_LSP_CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setenv('CLARA_JAVA_LSP_VERSION', '1.60.0')
    product = tmp_path / 'cache' / 'jdtls' / '1.60.0'
    plugins = product / 'plugins'
    plugins.mkdir(parents=True)
    (product / 'config_linux').mkdir()
    (plugins / 'org.eclipse.equinox.launcher_1.6.900.v20240613-2000.jar').write_bytes(b'jar')
    (product / '.nemo-ready').write_text('1.60.0\n', encoding='utf-8')
    monkeypatch.setattr(jdtls_product, '_platform_config_dirname', lambda: 'config_linux')


def _use_java_settings(monkeypatch: pytest.MonkeyPatch, **values: object) -> None:
    monkeypatch.setattr(java_server, '_java_lsp_settings', lambda: RuntimeJavaLspConfig(**values))


def test_java_command_uses_the_max_heap_setting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _installed_product(tmp_path, monkeypatch)
    fake_java = tmp_path / 'java'
    monkeypatch.setattr(java_server, 'resolve_java_executable', lambda: fake_java)

    assert '-Xmx1G' in build_java_lsp_command(tmp_path), 'the heap Clara always used, until someone changes it'

    _use_java_settings(monkeypatch, max_heap='4G')
    cmd = build_java_lsp_command(tmp_path)
    assert '-Xmx4G' in cmd
    assert '-Xmx1G' not in cmd


def test_java_command_keeps_project_files_out_of_the_project_only_when_asked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _installed_product(tmp_path, monkeypatch)
    fake_java = tmp_path / 'java'
    monkeypatch.setattr(java_server, 'resolve_java_executable', lambda: fake_java)
    prop = '-Djava.import.generatesMetadataFilesAtProjectRoot=false'

    assert prop not in build_java_lsp_command(tmp_path), 'unset means JDT LS writes them, as it always has'

    _use_java_settings(monkeypatch, project_metadata_at_root=False)
    cmd = build_java_lsp_command(tmp_path)
    assert prop in cmd
    assert cmd.index(prop) < cmd.index('-jar'), 'a JVM option: it does nothing after -jar'


def test_import_off_gets_its_own_data_dir_so_a_kept_project_cannot_linger(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _installed_product(tmp_path, monkeypatch)
    fake_java = tmp_path / 'java'
    monkeypatch.setattr(java_server, 'resolve_java_executable', lambda: fake_java)

    def data_dir() -> str:
        cmd = build_java_lsp_command(tmp_path, instance_key='sess:workspace:maven')
        return cmd[cmd.index('-data') + 1]

    default = data_dir()
    assert data_dir() == default

    _use_java_settings(monkeypatch, max_heap='4G', project_metadata_at_root=False)
    assert data_dir() == default, 'only the import settings move it; other settings keep the imported project'

    _use_java_settings(monkeypatch, import_maven=False)
    no_maven = data_dir()
    _use_java_settings(monkeypatch, import_gradle=False)
    no_gradle = data_dir()
    assert len({default, no_maven, no_gradle}) == 3

    _use_java_settings(monkeypatch)
    assert data_dir() == default, 'turning import back on returns to the imported project'


def _fake_jdk(root: Path) -> Path:
    java_bin = root / 'bin' / ('java.exe' if os.name == 'nt' else 'java')
    java_bin.parent.mkdir(parents=True)
    java_bin.write_bytes(b'')
    return java_bin


def test_jdk_folder_setting_wins_over_java_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    chosen = _fake_jdk(tmp_path / 'chosen')
    other = _fake_jdk(tmp_path / 'other')
    monkeypatch.setenv('JAVA_HOME', str(other.parent.parent))
    monkeypatch.setattr(java_server, '_java_major_version', lambda _bin: 21)

    assert resolve_java_executable() == other.resolve(), 'no setting: JAVA_HOME as before'

    _use_java_settings(monkeypatch, jdk_home=str(chosen.parent.parent))
    assert resolve_java_executable() == chosen.resolve()


def test_jdk_folder_setting_never_falls_back_to_another_jdk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    other = _fake_jdk(tmp_path / 'other')
    monkeypatch.setenv('JAVA_HOME', str(other.parent.parent))
    monkeypatch.setattr(java_server, '_java_major_version', lambda _bin: 21)

    _use_java_settings(monkeypatch, jdk_home=str(tmp_path / 'missing'))
    with pytest.raises(JavaLspSetupError, match='Settings'):
        resolve_java_executable()


@pytest.mark.parametrize(('major', 'message'), [(17, 'JDK 21'), (None, 'Could not read')])
def test_jdk_folder_setting_rejects_an_unusable_jdk(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    major: int | None,
    message: str,
) -> None:
    jdk = _fake_jdk(tmp_path / 'jdk')
    monkeypatch.setattr(java_server, '_java_major_version', lambda _bin: major)
    _use_java_settings(monkeypatch, jdk_home=str(jdk.parent.parent))
    with pytest.raises(JavaLspSetupError, match=message):
        resolve_java_executable()
