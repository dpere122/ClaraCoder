"""Tests for :mod:`clara_coder_backend.workspace_index.thread_priority`."""

from __future__ import annotations

import sys
import threading

import pytest

from clara_coder_backend.workspace_index import thread_priority as tp


def test_lists_this_threads_id() -> None:
    ids = tp.native_thread_ids()
    if sys.platform == 'win32' or sys.platform.startswith('linux'):
        assert threading.get_native_id() in ids


def test_finds_a_newly_started_thread() -> None:
    before = tp.native_thread_ids()
    release = threading.Event()
    started = threading.Event()
    native: list[int] = []

    def work() -> None:
        native.append(threading.get_native_id())
        started.set()
        release.wait(5)

    thread = threading.Thread(target=work)
    thread.start()
    try:
        started.wait(5)
        new = tp.native_thread_ids() - before
        if sys.platform == 'win32' or sys.platform.startswith('linux'):
            assert native[0] in new
    finally:
        release.set()
        thread.join()


@pytest.mark.skipif(sys.platform != 'win32', reason='Win32 thread priority')
def test_lowers_a_thread_below_normal_on_windows() -> None:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.GetCurrentThread.restype = wintypes.HANDLE
    kernel32.GetThreadPriority.argtypes = [wintypes.HANDLE]
    release = threading.Event()
    started = threading.Event()
    native: list[int] = []
    seen: list[int] = []

    def work() -> None:
        native.append(threading.get_native_id())
        started.set()
        release.wait(5)
        seen.append(kernel32.GetThreadPriority(kernel32.GetCurrentThread()))

    thread = threading.Thread(target=work)
    thread.start()
    started.wait(5)
    assert tp.lower_thread_priority({native[0]}) == 1
    release.set()
    thread.join()
    assert seen == [-1]


def test_a_thread_that_is_gone_is_not_counted() -> None:
    if sys.platform == 'win32':
        assert tp.lower_thread_priority({0xFFFFFFF0}) == 0
