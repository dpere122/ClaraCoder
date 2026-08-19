"""Whisper optional-dep status, Hub cache listing, install/delete (no pip / Hub)."""

from __future__ import annotations

import subprocess
from pathlib import Path

from clara_coder_backend.runtime.deps.providers import whisper as w


def test_whisper_status_missing(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(w, 'venv_python', lambda: None)
    monkeypatch.setattr(w, '_marker_path', lambda: tmp_path / 'no-marker')
    monkeypatch.setattr(w, 'list_downloaded_models', lambda root=None: [])
    st = w.status()
    assert st['id'] == 'whisper'
    assert st['state'] == 'missing'
    assert st['version'] is None
    assert st['downloadedModels'] == []


def test_whisper_status_installed_when_import_ok(monkeypatch, tmp_path: Path) -> None:
    py = tmp_path / 'python'
    py.write_text('', encoding='utf-8')
    marker = tmp_path / 'marker'
    marker.write_text('whisper\n', encoding='utf-8')
    monkeypatch.setattr(w, 'venv_python', lambda: py)
    monkeypatch.setattr(w, '_marker_path', lambda: marker)
    monkeypatch.setattr(w, 'list_downloaded_models', lambda root=None: ['small'])

    def _ok(*_args, **_kwargs):
        return subprocess.CompletedProcess(['python', '-c', 'import faster_whisper'], 0)

    monkeypatch.setattr(w.subprocess, 'run', _ok)
    st = w.status()
    assert st['state'] == 'installed'
    assert st['version'] == 'whisper'
    assert st['downloadedModels'] == ['small']


def test_whisper_status_error_when_import_fails(monkeypatch, tmp_path: Path) -> None:
    py = tmp_path / 'python'
    py.write_text('', encoding='utf-8')
    marker = tmp_path / 'marker'
    marker.write_text('whisper\n', encoding='utf-8')
    monkeypatch.setattr(w, 'venv_python', lambda: py)
    monkeypatch.setattr(w, '_marker_path', lambda: marker)
    monkeypatch.setattr(w, 'list_downloaded_models', lambda root=None: [])

    def _fail(*_args, **_kwargs):
        raise subprocess.CalledProcessError(1, ['python', '-c', 'import faster_whisper'])

    monkeypatch.setattr(w.subprocess, 'run', _fail)
    st = w.status()
    assert st['state'] == 'error'
    assert st['error']


def test_whisper_models_dir_uses_custom_root(tmp_path: Path) -> None:
    from clara_coder_backend.runtime.deps.paths import whisper_models_dir

    got = whisper_models_dir(str(tmp_path))
    assert got == (tmp_path.resolve() / 'whisper')


def test_list_downloaded_models_from_hub_cache(tmp_path: Path) -> None:
    repo = w.hub_cache_dirname('Systran/faster-whisper-small')
    snap = tmp_path / repo / 'snapshots' / 'abc123'
    snap.mkdir(parents=True)
    (snap / 'model.bin').write_bytes(b'weights')
    assert w.list_downloaded_models(tmp_path) == ['small']


def test_list_downloaded_models_accepts_config_json_snapshot(tmp_path: Path) -> None:
    repo = w.hub_cache_dirname('Systran/faster-whisper-tiny')
    snap = tmp_path / repo / 'snapshots' / 'def456'
    snap.mkdir(parents=True)
    (snap / 'config.json').write_text('{}', encoding='utf-8')
    assert w.list_downloaded_models(tmp_path) == ['tiny']


def test_normalize_whisper_size_rejects_unknown() -> None:
    import pytest

    with pytest.raises(RuntimeError, match='Unsupported Whisper size'):
        w.normalize_whisper_size('nope')


def test_install_downloads_extra_size_when_packages_ready(monkeypatch, tmp_path: Path) -> None:
    py = tmp_path / 'python'
    py.write_text('', encoding='utf-8')
    pip_calls: list[str] = []
    dl_calls: list[str] = []
    monkeypatch.setattr(w.python_runtime_provider, 'status', lambda: {'state': 'installed'})
    monkeypatch.setattr(w, 'venv_python', lambda: py)
    monkeypatch.setattr(w, 'status', lambda: {'state': 'installed', 'downloadedModels': []})
    monkeypatch.setattr(w, 'size_is_downloaded', lambda size, root=None: False)
    monkeypatch.setattr(w, '_install_packages', lambda _py: pip_calls.append('pip'))
    monkeypatch.setattr(w, '_download_size', lambda _py, size: dl_calls.append(size))
    monkeypatch.setattr(w.PROGRESS, 'emit', lambda *_a, **_k: None)

    w.install(variant='tiny')
    assert pip_calls == []
    assert dl_calls == ['tiny']


def test_install_skips_download_when_size_present(monkeypatch, tmp_path: Path) -> None:
    py = tmp_path / 'python'
    py.write_text('', encoding='utf-8')
    dl_calls: list[str] = []
    monkeypatch.setattr(w.python_runtime_provider, 'status', lambda: {'state': 'installed'})
    monkeypatch.setattr(w, 'venv_python', lambda: py)
    monkeypatch.setattr(w, 'status', lambda: {'state': 'installed'})
    monkeypatch.setattr(w, 'size_is_downloaded', lambda size, root=None: True)
    monkeypatch.setattr(w, '_download_size', lambda _py, size: dl_calls.append(size))
    monkeypatch.setattr(w.PROGRESS, 'emit', lambda *_a, **_k: None)

    w.install(variant='small')
    assert dl_calls == []


def test_delete_removes_models_dir(monkeypatch, tmp_path: Path) -> None:
    models = tmp_path / 'whisper'
    models.mkdir()
    (models / 'stale.bin').write_bytes(b'x')
    monkeypatch.setattr(w, 'venv_python', lambda: None)
    monkeypatch.setattr(w, '_marker_path', lambda: tmp_path / 'no-marker')
    monkeypatch.setattr(w, 'whisper_models_dir', lambda *_a, **_k: models)
    monkeypatch.setattr(w, 'list_downloaded_models', lambda root=None: [])
    monkeypatch.setattr(w.PROGRESS, 'emit', lambda *_a, **_k: None)

    w.delete()
    assert not models.exists()
