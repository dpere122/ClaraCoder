"""The gdls dependency provider: asset choice, checksums, install layout, cargo fallback."""

from __future__ import annotations

import hashlib
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps import paths as deps_paths
from clara_coder_backend.runtime.deps import registry
from clara_coder_backend.runtime.deps.providers import gdls

TAG = gdls.DEFAULT_TAG


@pytest.fixture
def runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(tmp_path))
    monkeypatch.delenv('CLARA_GDLS_VERSION', raising=False)
    monkeypatch.setattr(gdls, '_stop_running_servers', lambda: None)
    monkeypatch.setattr(gdls, '_check_runs', lambda binary: None)
    # The tests exercise the zip path whatever platform they run on.
    monkeypatch.setattr(gdls, '_binary_name', lambda: 'gdls.exe')
    return tmp_path


def _zip_with_binary(path: Path, *, name: str = 'gdls.exe') -> bytes:
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr(name, b'binary')
    return path.read_bytes()


def _serve_asset(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *, sums: str | None = None) -> list[str]:
    """Make ``download_file`` serve a local zip; returns the URLs requested."""

    source = tmp_path / 'source.zip'
    _zip_with_binary(source)
    requested: list[str] = []

    def fake_download(url: str, dest: Path, *, on_progress=None, timeout: int = 120) -> None:  # noqa: ANN001
        requested.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if url.endswith(gdls._CHECKSUMS_ASSET):
            dest.write_text(sums or '', encoding='utf-8')
        else:
            dest.write_bytes(source.read_bytes())

    monkeypatch.setattr(gdls, 'download_file', fake_download)
    return requested


def _source_digest(tmp_path: Path) -> str:
    return hashlib.sha256((tmp_path / 'source.zip').read_bytes()).hexdigest()


def _use_windows_asset(monkeypatch: pytest.MonkeyPatch) -> str:
    asset = f'gdls-{TAG}-windows-x86_64.zip'
    monkeypatch.setattr(gdls, 'prebuilt_asset_name', lambda tag: f'gdls-{tag}-windows-x86_64.zip')
    return asset


@pytest.mark.parametrize(
    ('platform_name', 'machine', 'expected'),
    [
        ('win32', 'AMD64', 'gdls-v9.9.9-windows-x86_64.zip'),
        ('linux', 'x86_64', 'gdls-v9.9.9-linux-x86_64.tar.gz'),
        ('darwin', 'arm64', None),
        ('darwin', 'x86_64', None),
        ('linux', 'aarch64', None),
    ],
)
def test_prebuilt_asset_per_platform(monkeypatch, platform_name, machine, expected) -> None:  # noqa: ANN001
    monkeypatch.setattr(sys, 'platform', platform_name)
    monkeypatch.setattr(gdls.platform, 'machine', lambda: machine)
    assert gdls.prebuilt_asset_name('v9.9.9') == expected


def test_pinned_tag_has_digests_for_both_published_assets() -> None:
    assert set(gdls._PINNED_SHA256) == {
        f'gdls-{TAG}-windows-x86_64.zip',
        f'gdls-{TAG}-linux-x86_64.tar.gz',
    }


def test_target_tag_override_and_bad_values(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv('CLARA_GDLS_VERSION', '3.2.0')
    assert gdls.target_tag() == 'v3.2.0'
    monkeypatch.setenv('CLARA_GDLS_VERSION', 'v3.2.0')
    assert gdls.target_tag() == 'v3.2.0'
    monkeypatch.setenv('CLARA_GDLS_VERSION', '../../evil')
    assert gdls.target_tag() == TAG


def test_parse_checksums_handles_binary_mode_marker() -> None:
    digest = 'a' * 64
    parsed = gdls.parse_checksums(f'{digest}  one.zip\n{digest.upper()} *two.tar.gz\nnot a line\n')
    assert parsed == {'one.zip': digest, 'two.tar.gz': digest}


def test_status_is_missing_without_touching_the_network(runtime, monkeypatch) -> None:  # noqa: ANN001
    def no_network(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise AssertionError('status must not download')

    monkeypatch.setattr(gdls, 'download_file', no_network)
    status = gdls.status()
    assert status['state'] == 'missing'
    assert status['path'] is None


def test_install_verifies_and_marks_ready(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    asset = _use_windows_asset(monkeypatch)
    requested = _serve_asset(monkeypatch, tmp_path)
    monkeypatch.setitem(gdls._PINNED_SHA256, asset, _source_digest(tmp_path))

    status = gdls.install()

    assert requested == [f'{gdls.REPO_URL}/releases/download/{TAG}/{asset}']
    assert status['state'] == 'installed'
    assert status['version'] == TAG
    assert Path(status['path']).parent == runtime / 'gdls' / TAG
    assert not list((runtime / 'downloads').glob('gdls-*')), 'the archive is removed'
    assert not list((runtime / 'gdls').glob('.staging-*')), 'staging is moved into place'


def test_checksum_mismatch_installs_nothing(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    asset = _use_windows_asset(monkeypatch)
    _serve_asset(monkeypatch, tmp_path)
    monkeypatch.setitem(gdls._PINNED_SHA256, asset, '0' * 64)

    with pytest.raises(RuntimeError, match='Checksum mismatch'):
        gdls.install()

    assert gdls.status()['state'] == 'missing'
    assert not list((runtime / 'downloads').glob('gdls-*'))


def test_override_version_is_checked_against_release_checksums(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    monkeypatch.setenv('CLARA_GDLS_VERSION', 'v9.0.0')
    _use_windows_asset(monkeypatch)
    source = tmp_path / 'source.zip'
    _zip_with_binary(source)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    requested = _serve_asset(monkeypatch, tmp_path, sums=f'{digest}  gdls-v9.0.0-windows-x86_64.zip\n')

    assert gdls.install()['version'] == 'v9.0.0'
    assert requested[0].endswith(f'v9.0.0/{gdls._CHECKSUMS_ASSET}')


def test_override_version_missing_from_checksums_fails(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    monkeypatch.setenv('CLARA_GDLS_VERSION', 'v9.0.0')
    _use_windows_asset(monkeypatch)
    _serve_asset(monkeypatch, tmp_path, sums=f'{"a" * 64}  something-else.zip\n')
    with pytest.raises(RuntimeError, match='no entry'):
        gdls.install()


def test_install_is_idempotent_unless_forced(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    asset = _use_windows_asset(monkeypatch)
    requested = _serve_asset(monkeypatch, tmp_path)
    monkeypatch.setitem(gdls._PINNED_SHA256, asset, _source_digest(tmp_path))
    gdls.install()
    gdls.install()
    assert len(requested) == 1
    gdls.install(force=True)
    assert len(requested) == 2


def test_no_server_can_start_while_the_install_changes(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    """An editor request mid-install would restart the old binary and lock it on Windows."""

    _fake_install(runtime, TAG)
    assert gdls.installed_binary() is not None
    asset = _use_windows_asset(monkeypatch)
    _serve_asset(monkeypatch, tmp_path)
    monkeypatch.setitem(gdls._PINNED_SHA256, asset, _source_digest(tmp_path))
    seen: dict[str, object] = {}
    real_place = gdls._place_binary

    def spy_stop() -> None:
        seen['at_stop'] = gdls.installed_binary()

    def spy_place(found: Path, staging: Path, tag: str) -> None:
        seen['at_replace'] = gdls.installed_binary()
        real_place(found, staging, tag)

    monkeypatch.setattr(gdls, '_stop_running_servers', spy_stop)
    monkeypatch.setattr(gdls, '_place_binary', spy_place)

    gdls.install(force=True)

    assert seen == {'at_stop': None, 'at_replace': None}
    assert gdls.installed_binary() is not None, 'servers may start again afterwards'


def test_a_failed_install_lets_servers_start_again(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    _fake_install(runtime, TAG)
    asset = _use_windows_asset(monkeypatch)
    _serve_asset(monkeypatch, tmp_path)
    monkeypatch.setitem(gdls._PINNED_SHA256, asset, '0' * 64)
    with pytest.raises(RuntimeError):
        gdls.install(force=True)
    assert gdls.installed_binary() is not None, 'the old install is intact and usable'


def test_binary_failing_to_start_is_not_marked_ready(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    asset = _use_windows_asset(monkeypatch)
    _serve_asset(monkeypatch, tmp_path)
    monkeypatch.setitem(gdls._PINNED_SHA256, asset, _source_digest(tmp_path))

    def broken(binary: Path) -> None:
        raise RuntimeError('Installed gdls did not start')

    monkeypatch.setattr(gdls, '_check_runs', broken)
    with pytest.raises(RuntimeError, match='did not start'):
        gdls.install()
    assert gdls.status()['state'] == 'missing'


def _fake_install(runtime: Path, tag: str) -> Path:
    version_dir = runtime / 'gdls' / tag
    version_dir.mkdir(parents=True)
    (version_dir / 'gdls.exe').write_bytes(b'x')
    (version_dir / gdls.READY_MARKER if hasattr(gdls, 'READY_MARKER') else version_dir / '.clara-ready').write_text(
        tag, encoding='utf-8'
    )
    return version_dir


def test_older_install_keeps_working_until_updated(runtime) -> None:  # noqa: ANN001
    _fake_install(runtime, 'v1.0.0')
    _fake_install(runtime, 'v2.10.0')
    _fake_install(runtime, 'v2.9.0')
    assert gdls.status()['version'] == 'v2.10.0'


def test_updating_removes_older_versions(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    old = _fake_install(runtime, 'v1.0.0')
    asset = _use_windows_asset(monkeypatch)
    _serve_asset(monkeypatch, tmp_path)
    monkeypatch.setitem(gdls._PINNED_SHA256, asset, _source_digest(tmp_path))
    gdls.install()
    assert not old.exists()
    assert gdls.status()['version'] == TAG


def test_delete_only_removes_gdls(runtime) -> None:  # noqa: ANN001
    _fake_install(runtime, TAG)
    (runtime / 'gdls' / 'stubs').mkdir()
    bin_dir = deps_paths.get_runtime_bin_dir()
    bin_dir.mkdir(parents=True)
    llama = bin_dir / 'llama-server.exe'
    llama.write_bytes(b'x')
    downloads = deps_paths.get_runtime_downloads_dir()
    downloads.mkdir(parents=True)
    unrelated = downloads / 'llama-b1.zip'
    unrelated.write_bytes(b'x')
    (downloads / 'gdls-v1.zip').write_bytes(b'x')

    assert gdls.delete()['state'] == 'missing'

    assert not (runtime / 'gdls').exists()
    assert not (downloads / 'gdls-v1.zip').exists()
    assert llama.exists()
    assert unrelated.exists()


def test_cleanup_partial_keeps_a_ready_install(runtime) -> None:  # noqa: ANN001
    version_dir = _fake_install(runtime, TAG)
    staging = runtime / 'gdls' / f'{gdls._STAGING_PREFIX}{TAG}'
    staging.mkdir()
    gdls.cleanup_partial()
    assert not staging.exists()
    assert version_dir.exists()


def test_without_cargo_the_error_points_to_rustup(runtime, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(gdls, 'prebuilt_asset_name', lambda tag: None)
    monkeypatch.setattr(gdls, '_find_cargo', lambda: None)
    with pytest.raises(RuntimeError, match='rustup.rs'):
        gdls.install()
    assert gdls.status()['state'] == 'missing'


def test_cargo_builds_the_pinned_tag_into_its_version_dir(runtime, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(gdls, 'prebuilt_asset_name', lambda tag: None)
    cargo = Path('/opt/rust/bin/cargo')
    monkeypatch.setattr(gdls, '_find_cargo', lambda: cargo)
    calls: list[tuple[list[str], dict[str, str]]] = []

    def fake_run(cmd: list[str], *, dep_id: str, label: str, timeout: float, env: dict[str, str]):  # noqa: ANN202
        calls.append((cmd, env))
        root = Path(cmd[cmd.index('--root') + 1])
        (root / 'bin').mkdir(parents=True)
        (root / 'bin' / 'gdls.exe').write_bytes(b'built')
        return subprocess.CompletedProcess(cmd, 0, '', '')

    monkeypatch.setattr(gdls, 'run_streaming', fake_run)

    status = gdls.install()

    cmd, env = calls[0]
    assert cmd[:2] == [str(cargo), 'install']
    assert cmd[cmd.index('--git') + 1] == gdls.REPO_URL
    assert cmd[cmd.index('--tag') + 1] == TAG
    assert '--locked' in cmd
    assert cmd[cmd.index('--bin') + 1] == 'gdls'
    assert cmd[-1] == 'gd_server'
    assert env['PATH'].startswith(str(cargo.parent))
    assert 'gdls-build-' in env['CARGO_TARGET_DIR']
    assert status['state'] == 'installed'
    assert Path(status['path']) == runtime / 'gdls' / TAG / 'gdls.exe'


def test_registered_as_a_dependency(runtime) -> None:  # noqa: ANN001
    assert 'gdls' in registry.DEPENDENCY_IDS
    info = registry.get_dependency('gdls')
    assert info['state'] == 'missing'
    assert info['components'] == ['gdls']
