"""Run native worker threads below normal priority, so background work yields to the desktop."""

from __future__ import annotations

import logging
import os
import sys

logger = logging.getLogger('clara.workspace_index.thread_priority')

_TH32CS_SNAPTHREAD = 0x00000004
_THREAD_SET_INFORMATION = 0x0020
_THREAD_QUERY_INFORMATION = 0x0040
_THREAD_PRIORITY_BELOW_NORMAL = -1
_LINUX_BACKGROUND_NICE = 10


def _kernel32():
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.OpenThread.restype = wintypes.HANDLE
    kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.SetThreadPriority.argtypes = [wintypes.HANDLE, ctypes.c_int]
    return kernel32


def _windows_thread_ids() -> set[int]:
    import ctypes
    from ctypes import wintypes

    class THREADENTRY32(ctypes.Structure):
        _fields_ = [
            ('dwSize', wintypes.DWORD),
            ('cntUsage', wintypes.DWORD),
            ('th32ThreadID', wintypes.DWORD),
            ('th32OwnerProcessID', wintypes.DWORD),
            ('tpBasePri', wintypes.LONG),
            ('tpDeltaPri', wintypes.LONG),
            ('dwFlags', wintypes.DWORD),
        ]

    kernel32 = _kernel32()
    snapshot = kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPTHREAD, 0)
    if snapshot in (None, wintypes.HANDLE(-1).value):
        return set()
    try:
        entry = THREADENTRY32()
        entry.dwSize = ctypes.sizeof(THREADENTRY32)
        owner = os.getpid()
        ids: set[int] = set()
        more = kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while more:
            if entry.th32OwnerProcessID == owner:
                ids.add(entry.th32ThreadID)
            more = kernel32.Thread32Next(snapshot, ctypes.byref(entry))
        return ids
    finally:
        kernel32.CloseHandle(snapshot)


def native_thread_ids() -> set[int]:
    """OS ids of this process's threads. Empty where they can't be listed."""
    try:
        if sys.platform == 'win32':
            return _windows_thread_ids()
        if sys.platform.startswith('linux'):
            return {int(name) for name in os.listdir('/proc/self/task')}
    except Exception as exc:
        logger.debug('could not list native threads: %s', exc)
    return set()


def lower_thread_priority(thread_ids: set[int]) -> int:
    """Move threads below normal priority. Returns how many changed; failure only costs the hint."""
    lowered = 0
    try:
        if sys.platform == 'win32':
            kernel32 = _kernel32()
            for tid in thread_ids:
                handle = kernel32.OpenThread(_THREAD_SET_INFORMATION | _THREAD_QUERY_INFORMATION, False, tid)
                if not handle:
                    continue
                try:
                    if kernel32.SetThreadPriority(handle, _THREAD_PRIORITY_BELOW_NORMAL):
                        lowered += 1
                finally:
                    kernel32.CloseHandle(handle)
        elif sys.platform.startswith('linux'):
            # On Linux, setpriority with a thread id applies to that one thread.
            for tid in thread_ids:
                os.setpriority(os.PRIO_PROCESS, tid, _LINUX_BACKGROUND_NICE)
                lowered += 1
    except Exception as exc:
        logger.debug('could not lower native thread priority: %s', exc)
    return lowered
