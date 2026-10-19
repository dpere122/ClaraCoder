"""Cancelling a dependency install: cancellation points and partial-install cleanup."""

from __future__ import annotations

import io
import sys
import threading
import time
from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps import cancel, download, registry
from clara_coder_backend.runtime.deps.cancel import InstallCancelled
from clara_coder_backend.runtime.deps.progress import PROGRESS


class _FakeResponse(io.BytesIO):
    headers = {'Content-Length': str(4 * 256 * 1024)}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_download_file_stops_and_removes_partial(monkeypatch, tmp_path: Path) -> None:
    dest = tmp_path / 'asset.zip'
    reads = {'n': 0}

    def fake_urlopen(req, timeout):
        resp = _FakeResponse(b'x' * (4 * 256 * 1024))
        original = resp.read

        def read(size=-1):
            reads['n'] += 1
            if reads['n'] == 2:
                cancel.request_cancel('llama-server')
            return original(size)

        resp.read = read  # type: ignore[method-assign]
        return resp

    monkeypatch.setattr(download, 'urlopen', fake_urlopen)
    with cancel.installing('llama-server'):
        with pytest.raises(InstallCancelled):
            download.download_file('https://example.invalid/asset.zip', dest)
    assert not dest.exists()
    assert not dest.with_suffix('.zip.partial').exists()


def test_run_streaming_stops_a_silent_child(tmp_path: Path) -> None:
    # A child that prints nothing for a long time: only the watcher can stop it.
    cmd = [sys.executable, '-c', 'import time; time.sleep(60)']
    timer = threading.Timer(0.5, cancel.request_cancel, args=('python-runtime',))
    started = time.monotonic()
    with cancel.installing('python-runtime'):
        timer.start()
        with pytest.raises(InstallCancelled):
            download.run_streaming(cmd, dep_id='python-runtime', label='sleep', echo_command=False)
    assert time.monotonic() - started < 20


def test_cancel_follows_the_running_install_not_the_step_label(tmp_path: Path) -> None:
    # Kokoro's pip step is labelled python-runtime; cancelling kokoro must still stop it.
    cmd = [sys.executable, '-c', 'import time; time.sleep(60)']
    timer = threading.Timer(0.5, cancel.request_cancel, args=('kokoro',))
    with cancel.installing('kokoro'):
        timer.start()
        with pytest.raises(InstallCancelled):
            download.run_streaming(cmd, dep_id='python-runtime', label='pip', echo_command=False)


def test_extract_archive_checks_between_members(tmp_path: Path) -> None:
    import zipfile

    archive = tmp_path / 'a.zip'
    with zipfile.ZipFile(archive, 'w') as zf:
        for i in range(5):
            zf.writestr(f'f{i}.txt', 'data')
    with cancel.installing('java-lsp'):
        cancel.request_cancel('java-lsp')
        with pytest.raises(InstallCancelled):
            download.extract_archive(archive, tmp_path / 'out')


def test_installing_drops_stale_requests() -> None:
    cancel.request_cancel('whisper')
    with cancel.installing('whisper'):
        assert not cancel.is_cancelled()
    assert not cancel.is_cancelled('whisper')


class _FakeProvider:
    """Writes a partial file into ``root``, then hits a cancel request mid-install."""

    def __init__(self, root: Path, *, installed_after_cancel: bool) -> None:
        self.root = root
        self.installed_after_cancel = installed_after_cancel
        self.deleted = False
        self.cleaned = False

    def install(self, *, force: bool = False) -> dict:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / 'half-written.bin').write_text('partial', encoding='utf-8')
        cancel.request_cancel('java-lsp')
        cancel.raise_if_cancelled()
        raise AssertionError('should have been cancelled')

    def cleanup_partial(self) -> None:
        self.cleaned = True

    def status(self) -> dict:
        state = 'installed' if self.installed_after_cancel else 'missing'
        return {'id': 'java-lsp', 'state': state}

    def delete(self) -> dict:
        self.deleted = True
        for child in self.root.iterdir():
            child.unlink()
        PROGRESS.emit('java-lsp', 'done', message='removed')
        return self.status()


@pytest.mark.parametrize('installed_after_cancel', [False, True])
def test_registry_cleans_up_after_cancel(monkeypatch, tmp_path: Path, installed_after_cancel: bool) -> None:
    provider = _FakeProvider(tmp_path / 'jdtls', installed_after_cancel=installed_after_cancel)
    monkeypatch.setattr(registry, '_providers', lambda: {'java-lsp': provider})
    events: list[dict] = []
    PROGRESS.subscribe(events.append)
    try:
        with pytest.raises(InstallCancelled):
            registry.install_dependency('java-lsp')
    finally:
        PROGRESS.unsubscribe(events.append)

    phases = [e['phase'] for e in events]
    assert phases[0] == 'queued'
    assert 'cancelling' in phases and phases[-1] == 'cancelled'
    assert 'error' not in phases
    assert provider.cleaned
    # A fresh install that never finished is removed; a still-valid install is kept.
    assert provider.deleted is (not installed_after_cancel)
    assert (tmp_path / 'jdtls' / 'half-written.bin').exists() is installed_after_cancel
    assert 'java-lsp' not in registry._errors
    assert 'java-lsp' not in registry._updating


def test_cancel_install_only_targets_running_installs(monkeypatch) -> None:
    monkeypatch.setattr(registry, '_updating', set())
    assert registry.cancel_install('llama-server') is False
    registry._updating.add('llama-server')
    try:
        assert registry.cancel_install('llama-server') is True
        assert cancel.is_cancelled('llama-server')
    finally:
        registry._updating.discard('llama-server')
        cancel._clear('llama-server')


def test_llama_cleanup_partial_removes_download_artifacts(monkeypatch, tmp_path: Path) -> None:
    from clara_coder_backend.runtime.deps.providers import llama_server

    downloads = tmp_path / 'downloads'
    (downloads / 'llama-extract-b1-vulkan').mkdir(parents=True)
    (downloads / 'llama-b1-bin-win-vulkan-x64.zip').write_text('zip', encoding='utf-8')
    (downloads / 'cudart-llama-bin-win-cuda-13.3-x64.zip.partial').write_text('p', encoding='utf-8')
    (downloads / 'jdtls.tar.gz').write_text('other dep', encoding='utf-8')
    monkeypatch.setattr(llama_server, 'get_runtime_downloads_dir', lambda: downloads)
    llama_server.cleanup_partial()
    assert sorted(p.name for p in downloads.iterdir()) == ['jdtls.tar.gz']
