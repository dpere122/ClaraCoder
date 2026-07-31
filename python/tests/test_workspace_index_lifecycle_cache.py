"""Tests for workspace fingerprint TTL prune and max-entry eviction."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from clara_coder_backend.workspace_index import lifecycle as lc


def _fp_key(root: Path, max_files: int) -> str:
    return f'{root.resolve()}\0{max_files}'


@pytest.fixture(autouse=True)
def _clear_fp_caches():
    lc._fingerprint_cache.clear()
    yield
    lc._fingerprint_cache.clear()


def test_cached_workspace_fingerprint_prunes_ttl_expired_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        'clara_coder_backend.workspace_index.fingerprint.workspace_content_fingerprint',
        lambda root, max_files: f'fp-{root.name}',
    )

    stale_root = tmp_path / 'stale'
    stale_root.mkdir()
    stale_key = _fp_key(stale_root, 10)
    lc._fingerprint_cache[stale_key] = (time.monotonic() - 200.0, 'old-fp')

    fresh_root = tmp_path / 'fresh'
    fresh_root.mkdir()
    out = lc.cached_workspace_fingerprint(fresh_root, max_files=10)

    assert out == 'fp-fresh'
    assert stale_key not in lc._fingerprint_cache


def test_cached_workspace_fingerprint_evicts_when_over_max_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lc, '_FINGERPRINT_CACHE_MAX_ENTRIES', 2)
    monkeypatch.setattr(
        'clara_coder_backend.workspace_index.fingerprint.workspace_content_fingerprint',
        lambda root, max_files: f'fp-{root.name}',
    )

    r1 = tmp_path / 'r1'
    r1.mkdir()
    r2 = tmp_path / 'r2'
    r2.mkdir()
    r3 = tmp_path / 'r3'
    r3.mkdir()
    now = time.monotonic()
    lc._fingerprint_cache[_fp_key(r1, 10)] = (now - 50.0, 'a')
    lc._fingerprint_cache[_fp_key(r2, 10)] = (now - 10.0, 'b')

    lc.cached_workspace_fingerprint(r3, max_files=10)

    assert len(lc._fingerprint_cache) == 2
    assert _fp_key(r3, 10) in lc._fingerprint_cache
    assert _fp_key(r1, 10) not in lc._fingerprint_cache
