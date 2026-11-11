"""The rust-analyzer dependency provider: asset choice, checksums, zip and gzip installs."""

from __future__ import annotations

import gzip
import hashlib
import zipfile
from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps import registry
from clara_coder_backend.runtime.deps.providers import rust_analyzer

TAG = rust_analyzer.DEFAULT_TAG
WINDOWS_ASSET = 'rust-analyzer-x86_64-pc-windows-msvc.zip'
LINUX_ASSET = 'rust-analyzer-x86_64-unknown-linux-gnu.gz'


@pytest.fixture
def runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(rust_analyzer, '_stop_running_servers', lambda: None)
    monkeypatch.setattr(rust_analyzer, '_check_runs', lambda binary: None)
    return tmp_path


def _serve(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asset: str) -> list[str]:
    """Make ``download_file`` serve a local copy of ``asset`` with a matching digest; returns the URLs requested."""

    source = tmp_path / f'source-{asset}'
    if asset.endswith('.zip'):
        with zipfile.ZipFile(source, 'w') as archive:
            archive.writestr('rust-analyzer.exe', b'binary')
            archive.writestr('rust-analyzer.pdb', b'symbols')
        binary_name = 'rust-analyzer.exe'
    else:
        source.write_bytes(gzip.compress(b'binary'))
        binary_name = 'rust-analyzer'
    requested: list[str] = []

    def fake_download(url: str, dest: Path, *, on_progress=None, timeout: int = 120) -> None:  # noqa: ANN001
        requested.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(source.read_bytes())

    monkeypatch.setattr(rust_analyzer, 'download_file', fake_download)
    monkeypatch.setattr(rust_analyzer, 'release_asset_name', lambda: asset)
    monkeypatch.setattr(rust_analyzer, '_binary_name', lambda: binary_name)
    monkeypatch.setitem(rust_analyzer._PINNED_SHA256, asset, hashlib.sha256(source.read_bytes()).hexdigest())
    return requested


def _fake_install(runtime: Path, tag: str) -> Path:
    version_dir = runtime / 'rust-analyzer' / tag
    version_dir.mkdir(parents=True)
    (version_dir / rust_analyzer._binary_name()).write_bytes(b'binary')
    rust_analyzer.write_ready_marker(version_dir, tag)
    return version_dir


@pytest.mark.parametrize(
    ('platform_name', 'machine', 'expected'),
    [
        ('win32', 'AMD64', 'rust-analyzer-x86_64-pc-windows-msvc.zip'),
        ('win32', 'ARM64', 'rust-analyzer-aarch64-pc-windows-msvc.zip'),
        ('linux', 'x86_64', 'rust-analyzer-x86_64-unknown-linux-gnu.gz'),
        ('linux', 'aarch64', 'rust-analyzer-aarch64-unknown-linux-gnu.gz'),
        ('darwin', 'arm64', 'rust-analyzer-aarch64-apple-darwin.gz'),
        ('darwin', 'x86_64', 'rust-analyzer-x86_64-apple-darwin.gz'),
        ('linux', 'riscv64', None),
    ],
)
def test_release_asset_per_platform(monkeypatch, platform_name, machine, expected) -> None:  # noqa: ANN001
    monkeypatch.setattr(rust_analyzer.sys, 'platform', platform_name)
    monkeypatch.setattr(rust_analyzer.platform, 'machine', lambda: machine)
    assert rust_analyzer.release_asset_name() == expected
    if expected is not None:
        assert len(rust_analyzer._PINNED_SHA256[expected]) == 64, 'every asset Clara can pick has a pinned digest'


def test_status_is_missing_without_touching_the_network(runtime, monkeypatch) -> None:  # noqa: ANN001
    def no_network(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise AssertionError('status must not download')

    monkeypatch.setattr(rust_analyzer, 'download_file', no_network)
    status = rust_analyzer.status()
    assert status['state'] == 'missing'
    assert status['path'] is None
    assert rust_analyzer.installed_binary() is None


def test_install_from_the_windows_zip(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    requested = _serve(monkeypatch, tmp_path, WINDOWS_ASSET)

    status = rust_analyzer.install()

    assert requested == [f'{rust_analyzer.REPO_URL}/releases/download/{TAG}/{WINDOWS_ASSET}']
    assert status['state'] == 'installed'
    assert status['version'] == TAG
    assert Path(status['path']) == runtime / 'rust-analyzer' / TAG / 'rust-analyzer.exe'
    assert Path(status['path']).read_bytes() == b'binary'
    assert not list((runtime / 'downloads').glob('rust-analyzer-*')), 'the archive is removed'
    assert not list((runtime / 'rust-analyzer').glob('.staging-*')), 'staging is moved into place'


def test_install_from_a_gzipped_executable(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    _serve(monkeypatch, tmp_path, LINUX_ASSET)

    status = rust_analyzer.install()

    binary = runtime / 'rust-analyzer' / TAG / 'rust-analyzer'
    assert Path(status['path']) == binary
    assert binary.read_bytes() == b'binary', 'the executable is unpacked, not left gzipped'


def test_checksum_mismatch_installs_nothing(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    _serve(monkeypatch, tmp_path, WINDOWS_ASSET)
    monkeypatch.setitem(rust_analyzer._PINNED_SHA256, WINDOWS_ASSET, '0' * 64)

    with pytest.raises(RuntimeError, match='Checksum mismatch'):
        rust_analyzer.install()

    assert rust_analyzer.status()['state'] == 'missing'
    assert not list((runtime / 'downloads').glob('rust-analyzer-*')), 'the bad archive is removed'


def test_a_platform_without_an_asset_says_so(runtime, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(rust_analyzer, 'release_asset_name', lambda: None)
    with pytest.raises(RuntimeError, match='CLARA_RUST_LSP_COMMAND'):
        rust_analyzer.install()


def test_install_is_idempotent_unless_forced(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    requested = _serve(monkeypatch, tmp_path, WINDOWS_ASSET)
    rust_analyzer.install()
    rust_analyzer.install()
    assert len(requested) == 1
    rust_analyzer.install(force=True)
    assert len(requested) == 2


def test_no_server_can_start_while_the_install_changes(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    """An editor request mid-install would restart the old binary and lock it on Windows."""

    _serve(monkeypatch, tmp_path, WINDOWS_ASSET)
    _fake_install(runtime, TAG)
    assert rust_analyzer.installed_binary() is not None
    seen: dict[str, object] = {}
    real_unpack = rust_analyzer._unpack

    def spy_stop() -> None:
        seen['at_stop'] = rust_analyzer.installed_binary()

    def spy_unpack(archive: Path, staging: Path) -> Path:
        seen['at_unpack'] = rust_analyzer.installed_binary()
        return real_unpack(archive, staging)

    monkeypatch.setattr(rust_analyzer, '_stop_running_servers', spy_stop)
    monkeypatch.setattr(rust_analyzer, '_unpack', spy_unpack)

    rust_analyzer.install(force=True)

    assert seen == {'at_stop': None, 'at_unpack': None}
    assert rust_analyzer.installed_binary() is not None, 'servers may start again afterwards'


def test_a_failed_install_lets_servers_start_again(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    _serve(monkeypatch, tmp_path, WINDOWS_ASSET)
    _fake_install(runtime, TAG)
    monkeypatch.setitem(rust_analyzer._PINNED_SHA256, WINDOWS_ASSET, '0' * 64)

    with pytest.raises(RuntimeError):
        rust_analyzer.install(force=True)

    assert rust_analyzer.installed_binary() is not None, 'the old install is still there to run'


def test_binary_failing_to_start_is_not_marked_ready(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    _serve(monkeypatch, tmp_path, WINDOWS_ASSET)

    def broken(binary: Path) -> None:
        raise RuntimeError('Installed rust-analyzer did not start: nope')

    monkeypatch.setattr(rust_analyzer, '_check_runs', broken)
    with pytest.raises(RuntimeError, match='did not start'):
        rust_analyzer.install()
    assert rust_analyzer.status()['state'] == 'missing'


def test_older_install_keeps_working_until_updated(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    _serve(monkeypatch, tmp_path, WINDOWS_ASSET)
    _fake_install(runtime, '2025-01-06')
    newer = _fake_install(runtime, '2025-06-30')
    assert rust_analyzer.installed_version_dir() == newer
    assert rust_analyzer.status()['version'] == '2025-06-30'

    rust_analyzer.install()

    assert sorted(p.name for p in (runtime / 'rust-analyzer').iterdir()) == [TAG], 'updating removes older versions'


def test_delete_and_cleanup(runtime, monkeypatch, tmp_path) -> None:  # noqa: ANN001
    _serve(monkeypatch, tmp_path, WINDOWS_ASSET)
    other = runtime / 'gdls'
    other.mkdir()
    ready = _fake_install(runtime, TAG)
    (runtime / 'rust-analyzer' / '.staging-x').mkdir()
    downloads = runtime / 'downloads'
    downloads.mkdir(exist_ok=True)
    (downloads / WINDOWS_ASSET).write_bytes(b'partial')
    (downloads / 'gdls-v1.zip').write_bytes(b'someone else')

    rust_analyzer.cleanup_partial()
    assert ready.is_dir(), 'a ready install is not partial'
    assert not (runtime / 'rust-analyzer' / '.staging-x').exists()
    assert not (downloads / WINDOWS_ASSET).exists()
    assert (downloads / 'gdls-v1.zip').exists()

    assert rust_analyzer.delete()['state'] == 'missing'
    assert not (runtime / 'rust-analyzer').exists()
    assert other.is_dir(), 'only rust-analyzer goes'


def test_registered_as_a_dependency(runtime) -> None:  # noqa: ANN001
    assert 'rust-analyzer' in registry.DEPENDENCY_IDS
    info = registry.get_dependency('rust-analyzer')
    assert info['state'] == 'missing'
    assert info['components'] == ['rust-analyzer']
