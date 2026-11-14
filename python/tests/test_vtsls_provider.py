"""The vtsls dependency provider: pinned npm tarballs, integrity checks and the node_modules layout."""

from __future__ import annotations

import base64
import hashlib
import io
import tarfile
from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps import registry
from clara_coder_backend.runtime.deps.providers import vtsls

TAG = vtsls.DEFAULT_TAG
NESTED = 'node_modules/vscode-languageserver/node_modules/vscode-jsonrpc'


@pytest.fixture
def runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv('CLARA_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(vtsls, '_stop_running_servers', lambda: None)
    return tmp_path


def _tarball(install_path: str, *, root: str = 'package') -> bytes:
    """A small npm-style tarball whose files sit under ``root/``."""

    name = install_path.rsplit('node_modules/', 1)[-1]
    files = {f'{root}/package.json': f'{{"name": "{name}"}}'.encode()}
    if install_path == 'node_modules/@vtsls/language-server':
        files[f'{root}/bin/vtsls.js'] = b'#!/usr/bin/env node\n'
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        for member_name, data in files.items():
            info = tarfile.TarInfo(member_name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def _integrity(data: bytes) -> str:
    return 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode('ascii')


def _serve(monkeypatch: pytest.MonkeyPatch, *, roots: dict[str, str] | None = None) -> list[str]:
    """Make ``download_file`` serve generated tarballs with matching pins; returns the URLs requested."""

    by_url: dict[str, bytes] = {}
    pins: list[tuple[str, str, str]] = []
    for install_path, url, _ in vtsls._PINNED_PACKAGES:
        data = _tarball(install_path, root=(roots or {}).get(install_path, 'package'))
        by_url[url] = data
        pins.append((install_path, url, _integrity(data)))
    requested: list[str] = []

    def fake_download(url: str, dest: Path, *, on_progress=None, timeout: int = 120) -> None:  # noqa: ANN001
        requested.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(by_url[url])

    monkeypatch.setattr(vtsls, 'download_file', fake_download)
    monkeypatch.setattr(vtsls, '_PINNED_PACKAGES', tuple(pins))
    return requested


def _fake_install(runtime: Path, tag: str) -> Path:
    version_dir = runtime / 'vtsls' / tag
    entry = version_dir.joinpath(*vtsls.ENTRY_RELATIVE.parts)
    entry.parent.mkdir(parents=True)
    entry.write_bytes(b'#!/usr/bin/env node\n')
    vtsls.write_ready_marker(version_dir, tag)
    return version_dir


def test_pins_cover_the_whole_lockfile_tree() -> None:
    paths = [install_path for install_path, _, _ in vtsls._PINNED_PACKAGES]
    assert len(paths) == 18
    assert len(set(paths)) == len(paths)
    assert 'node_modules/@vtsls/language-server' in paths
    assert 'node_modules/typescript' in paths
    assert NESTED in paths
    for install_path, url, integrity in vtsls._PINNED_PACKAGES:
        assert install_path.startswith('node_modules/')
        assert url.startswith('https://registry.npmjs.org/') and url.endswith('.tgz')
        assert integrity.startswith('sha512-')
        assert len(base64.b64decode(integrity.removeprefix('sha512-'))) == 64, install_path


def test_status_is_missing_without_touching_the_network(runtime, monkeypatch) -> None:  # noqa: ANN001
    def no_network(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise AssertionError('status must not download')

    monkeypatch.setattr(vtsls, 'download_file', no_network)
    status = vtsls.status()
    assert status['state'] == 'missing'
    assert status['path'] is None
    assert vtsls.installed_binary() is None


def test_install_lays_out_node_modules(runtime, monkeypatch) -> None:  # noqa: ANN001
    requested = _serve(monkeypatch)

    status = vtsls.install()

    version_dir = runtime / 'vtsls' / TAG
    assert sorted(requested) == sorted(url for _, url, _ in vtsls._PINNED_PACKAGES)
    assert status['state'] == 'installed'
    assert status['version'] == TAG
    entry = version_dir / 'node_modules' / '@vtsls' / 'language-server' / 'bin' / 'vtsls.js'
    assert Path(status['path']) == entry
    assert vtsls.installed_binary() == entry
    assert (version_dir / 'node_modules' / 'typescript' / 'package.json').is_file()
    nested = version_dir / 'node_modules' / 'vscode-languageserver' / 'node_modules' / 'vscode-jsonrpc'
    assert (nested / 'package.json').is_file(), 'nested packages stay inside their parent'
    assert (version_dir / 'node_modules' / 'vscode-languageserver' / 'package.json').is_file()
    assert vtsls.read_ready_marker(version_dir) == TAG
    assert not list((runtime / 'downloads').glob('vtsls-*')), 'the tarballs are removed'
    assert sorted(p.name for p in (runtime / 'vtsls').iterdir()) == [TAG], 'staging and unpack dirs are gone'


def test_a_tarball_root_other_than_package_is_accepted(runtime, monkeypatch) -> None:  # noqa: ANN001
    _serve(monkeypatch, roots={'node_modules/yallist': 'yallist'})

    vtsls.install()

    assert (runtime / 'vtsls' / TAG / 'node_modules' / 'yallist' / 'package.json').is_file()


def test_checksum_mismatch_installs_nothing(runtime, monkeypatch) -> None:  # noqa: ANN001
    _serve(monkeypatch)
    pins = list(vtsls._PINNED_PACKAGES)
    install_path, url, _ = pins[7]
    pins[7] = (install_path, url, 'sha512-' + base64.b64encode(b'\0' * 64).decode('ascii'))
    monkeypatch.setattr(vtsls, '_PINNED_PACKAGES', tuple(pins))

    with pytest.raises(RuntimeError, match='Checksum mismatch'):
        vtsls.install()

    assert vtsls.status()['state'] == 'missing'
    assert not (runtime / 'vtsls' / TAG).exists(), 'no version folder'
    assert not list((runtime / 'vtsls').iterdir()), 'no staging or unpack folder'
    assert not list((runtime / 'downloads').glob('vtsls-*')), 'no tarball'


def test_install_is_idempotent_unless_forced(runtime, monkeypatch) -> None:  # noqa: ANN001
    requested = _serve(monkeypatch)
    vtsls.install()
    vtsls.install()
    assert len(requested) == len(vtsls._PINNED_PACKAGES)
    vtsls.install(force=True)
    assert len(requested) == 2 * len(vtsls._PINNED_PACKAGES)


def test_no_server_can_start_while_the_install_changes(runtime, monkeypatch) -> None:  # noqa: ANN001
    _serve(monkeypatch)
    _fake_install(runtime, TAG)
    assert vtsls.installed_binary() is not None
    seen: dict[str, object] = {}
    real_place = vtsls._place_package

    def spy_stop() -> None:
        seen['at_stop'] = vtsls.installed_binary()

    def spy_place(archive: Path, unpack: Path, dest: Path) -> None:
        seen.setdefault('at_place', vtsls.installed_binary())
        real_place(archive, unpack, dest)

    monkeypatch.setattr(vtsls, '_stop_running_servers', spy_stop)
    monkeypatch.setattr(vtsls, '_place_package', spy_place)

    vtsls.install(force=True)

    assert seen == {'at_stop': None, 'at_place': None}
    assert vtsls.installed_binary() is not None, 'servers may start again afterwards'


def test_a_failed_reinstall_keeps_the_old_install(runtime, monkeypatch) -> None:  # noqa: ANN001
    _serve(monkeypatch)
    _fake_install(runtime, TAG)
    pins = list(vtsls._PINNED_PACKAGES)
    install_path, url, _ = pins[0]
    pins[0] = (install_path, url, 'sha512-' + base64.b64encode(b'\0' * 64).decode('ascii'))
    monkeypatch.setattr(vtsls, '_PINNED_PACKAGES', tuple(pins))

    with pytest.raises(RuntimeError):
        vtsls.install(force=True)

    assert vtsls.installed_binary() is not None, 'the old install is still there to run'


def test_older_install_keeps_working_until_updated(runtime, monkeypatch) -> None:  # noqa: ANN001
    _serve(monkeypatch)
    _fake_install(runtime, '0.2.9')
    newer = _fake_install(runtime, '0.2.10')
    assert vtsls.installed_version_dir() == newer, 'versions compare numerically'
    assert vtsls.status()['version'] == '0.2.10'

    vtsls.install()

    assert sorted(p.name for p in (runtime / 'vtsls').iterdir()) == [TAG], 'updating removes older versions'


def test_delete_and_cleanup(runtime) -> None:  # noqa: ANN001
    other = runtime / 'gdls'
    other.mkdir()
    ready = _fake_install(runtime, TAG)
    (runtime / 'vtsls' / '.staging-x').mkdir()
    (runtime / 'vtsls' / '.unpack-x').mkdir()
    downloads = runtime / 'downloads'
    downloads.mkdir(exist_ok=True)
    (downloads / 'vtsls-01-l10n-0.0.18.tgz').write_bytes(b'partial')
    (downloads / 'gdls-v1.zip').write_bytes(b'someone else')

    vtsls.cleanup_partial()
    assert ready.is_dir(), 'a ready install is not partial'
    assert not (runtime / 'vtsls' / '.staging-x').exists()
    assert not (runtime / 'vtsls' / '.unpack-x').exists()
    assert not (downloads / 'vtsls-01-l10n-0.0.18.tgz').exists()
    assert (downloads / 'gdls-v1.zip').exists()

    assert vtsls.delete()['state'] == 'missing'
    assert not (runtime / 'vtsls').exists()
    assert vtsls.installed_binary() is None
    assert other.is_dir(), 'only vtsls goes'


def test_registered_as_a_dependency(runtime) -> None:  # noqa: ANN001
    assert 'vtsls' in registry.DEPENDENCY_IDS
    assert set(registry._providers()) == set(registry.DEPENDENCY_IDS)
    info = registry.get_dependency('vtsls')
    assert info['state'] == 'missing'
    assert info['label'] == 'TypeScript/JS LSP (vtsls)'
    assert info['components'] == ['@vtsls/language-server', 'typescript']
