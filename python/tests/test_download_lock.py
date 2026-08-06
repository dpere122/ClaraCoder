"""Tests for download-lock acquire / stale reclaim."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps import download as dl


def test_with_download_lock_acquires_and_releases(tmp_path: Path) -> None:
    lock = tmp_path / 'dep.lock'
    with dl.with_download_lock(lock, ready_check=lambda: False) as ctx:
        assert ctx.held is True
        assert lock.is_file()
        assert lock.read_text(encoding='utf-8').strip() == str(os.getpid())
    assert not lock.exists()


def test_with_download_lock_reclaims_empty_stale_lock(tmp_path: Path) -> None:
    """Empty lock left by a crashed older installer must not block forever."""
    lock = tmp_path / 'dep.lock'
    lock.write_text('', encoding='utf-8')
    with dl.with_download_lock(lock, ready_check=lambda: False, wait_s=5.0) as ctx:
        assert ctx.held is True
        assert lock.read_text(encoding='utf-8').strip() == str(os.getpid())
    assert not lock.exists()


def test_with_download_lock_reclaims_dead_pid_lock(tmp_path: Path) -> None:
    lock = tmp_path / 'dep.lock'
    # PID 2**31-1 is virtually never a live process; kill(pid, 0) → ESRCH.
    lock.write_text('2147483647\n', encoding='utf-8')
    with dl.with_download_lock(lock, ready_check=lambda: False, wait_s=5.0) as ctx:
        assert ctx.held is True
    assert not lock.exists()


def test_with_download_lock_waits_then_times_out_for_live_holder(tmp_path: Path) -> None:
    lock = tmp_path / 'dep.lock'
    lock.write_text(f'{os.getpid()}\n', encoding='utf-8')
    # Our own PID is alive, so reclaim must not fire.
    with pytest.raises(TimeoutError, match='Timed out waiting for download lock'):
        with dl.with_download_lock(lock, ready_check=lambda: False, wait_s=0.6):
            pass
    assert lock.is_file()


def test_with_download_lock_returns_unheld_when_ready_during_wait(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock = tmp_path / 'dep.lock'
    lock.write_text(f'{os.getpid()}\n', encoding='utf-8')
    ready = {'ok': False}

    def _ready() -> bool:
        return ready['ok']

    # Flip ready after the first failed acquire so the waiter exits cleanly.
    calls = {'n': 0}
    original_sleep = dl.time.sleep

    def _sleep(_s: float) -> None:
        calls['n'] += 1
        if calls['n'] >= 1:
            ready['ok'] = True
        original_sleep(0.01)

    monkeypatch.setattr(dl.time, 'sleep', _sleep)
    with dl.with_download_lock(lock, ready_check=_ready, wait_s=5.0) as ctx:
        assert ctx.held is False
    # Ready path must not delete someone else's lock.
    assert lock.is_file()
