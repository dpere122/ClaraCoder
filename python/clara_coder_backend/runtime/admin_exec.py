"""Launch and talk to the elevated command broker (Windows UAC / Linux pkexec)."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

_BROKERS: dict[str, 'BrokerClient'] = {}
#: Per-session launch lock so two concurrent elevated calls cannot spawn two
#: helpers (and two UAC / polkit prompts) for the same chat session.
_LAUNCH_LOCKS: dict[str, asyncio.Lock] = {}
_LAUNCH_TIMEOUT_SEC = 300.0


def elevation_privilege_label() -> str:
    """Human label for the OS admin principal."""

    return 'administrator' if sys.platform == 'win32' else 'root'


def admin_elevation_supported() -> bool:
    return sys.platform == 'win32' or sys.platform.startswith('linux')


def is_currently_privileged() -> bool:
    """True when this process already has admin/root rights."""

    if sys.platform == 'win32':
        try:
            import ctypes

            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except (AttributeError, OSError):
            return False
    try:
        return os.geteuid() == 0
    except AttributeError:
        return False


def python_package_root() -> Path:
    """Directory that must be on ``sys.path`` for ``clara_coder_backend`` imports."""

    return Path(__file__).resolve().parents[1].parent


@dataclass
class ElevatedJobHandle:
    """Sidecar-side handle for one job running in the broker."""

    job_id: str
    client: 'BrokerClient'
    persist_client: bool
    _chunks: asyncio.Queue[bytes | None] = field(default_factory=asyncio.Queue)
    _exit: asyncio.Event = field(default_factory=asyncio.Event)
    exit_code: int | None = None

    async def iter_chunks(self) -> AsyncIterator[bytes]:
        while True:
            item = await self._chunks.get()
            if item is None:
                return
            yield item

    async def wait(self) -> int:
        await self._exit.wait()
        return int(self.exit_code if self.exit_code is not None else 1)

    async def kill(self) -> None:
        await self.client.kill_job(self.job_id)

    def _push_data(self, data: bytes) -> None:
        self._chunks.put_nowait(data)

    def _finish(self, code: int) -> None:
        if self._exit.is_set():
            return
        self.exit_code = code
        self._chunks.put_nowait(None)
        self._exit.set()


class BrokerClient:
    """One TCP session to an elevated broker."""

    def __init__(
        self,
        session_id: str,
        *,
        persist: bool,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        pid: int | None,
        config_path: Path | None,
        port_file: Path | None,
    ) -> None:
        self.session_id = session_id
        self.persist = persist
        self.reader = reader
        self.writer = writer
        self.pid = pid
        self.config_path = config_path
        self.port_file = port_file
        self.jobs: dict[str, ElevatedJobHandle] = {}
        self._lock = asyncio.Lock()
        self._alive = True
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        try:
            while self._alive:
                raw = await self.reader.readline()
                if not raw:
                    break
                try:
                    msg = json.loads(raw.decode('utf-8'))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                op = str(msg.get('op') or '')
                job_id = str(msg.get('job_id') or '')
                handle = self.jobs.get(job_id)
                if op == 'data' and handle is not None:
                    try:
                        handle._push_data(base64.b64decode(str(msg.get('b64') or ''), validate=True))
                    except (ValueError, TypeError):
                        pass
                elif op == 'exit' and handle is not None:
                    try:
                        code = int(msg.get('code'))
                    except (TypeError, ValueError):
                        code = 1
                    handle._finish(code)
                    self.jobs.pop(job_id, None)
                    self._schedule_ephemeral_shutdown()
                elif op == 'run_err' and handle is not None:
                    err = str(msg.get('error') or 'elevated command failed to start')
                    handle._push_data(f'Tool error: {err}\n'.encode('utf-8'))
                    handle._finish(1)
                    self.jobs.pop(job_id, None)
                    self._schedule_ephemeral_shutdown()
        finally:
            self._alive = False
            for handle in list(self.jobs.values()):
                handle._finish(1)
            self.jobs.clear()
            # A dead client is useless whether or not it was persistent: drop it
            # so the next elevated call relaunches, and reclaim its temp files.
            if _BROKERS.get(self.session_id) is self:
                _BROKERS.pop(self.session_id, None)
            _cleanup_path(self.config_path)
            _cleanup_path(self.port_file)

    async def start_job(
        self,
        job_id: str,
        *,
        command: str,
        cwd: str,
        env: dict[str, str] | None,
    ) -> ElevatedJobHandle:
        handle = ElevatedJobHandle(job_id=job_id, client=self, persist_client=self.persist)
        self.jobs[job_id] = handle
        async with self._lock:
            self.writer.write(
                (
                    json.dumps(
                        {
                            'op': 'run',
                            'job_id': job_id,
                            'command': command,
                            'cwd': cwd,
                            'env': env,
                        },
                        separators=(',', ':'),
                    )
                    + '\n'
                ).encode('utf-8')
            )
            await self.writer.drain()
        return handle

    async def kill_job(self, job_id: str) -> None:
        async with self._lock:
            if not self._alive:
                return
            self.writer.write(
                (json.dumps({'op': 'kill', 'job_id': job_id}, separators=(',', ':')) + '\n').encode('utf-8')
            )
            try:
                await self.writer.drain()
            except (ConnectionError, OSError):
                pass

    def _schedule_ephemeral_shutdown(self) -> None:
        if self.persist or self.jobs:
            return
        asyncio.create_task(shutdown_session_broker(self.session_id))

    async def close(self) -> None:
        self._alive = False
        try:
            async with self._lock:
                self.writer.write((json.dumps({'op': 'shutdown'}, separators=(',', ':')) + '\n').encode('utf-8'))
                await self.writer.drain()
        except (ConnectionError, OSError, RuntimeError):
            pass
        try:
            self.writer.close()
            await self.writer.wait_closed()
        except (ConnectionError, OSError):
            pass
        if self._reader_task is not asyncio.current_task():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
        # Best effort only: an unelevated sidecar usually cannot signal the
        # elevated helper. The broker exits by itself once its client is gone.
        if self.pid:
            await _kill_pid(self.pid)
        _cleanup_path(self.config_path)
        _cleanup_path(self.port_file)


def _cleanup_path(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


async def _kill_pid(pid: int) -> None:
    if pid <= 0:
        return
    if sys.platform == 'win32':

        def _win() -> None:
            import subprocess

            flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            try:
                subprocess.run(
                    ['taskkill', '/PID', str(pid), '/T', '/F'],
                    capture_output=True,
                    timeout=20,
                    creationflags=flags,
                )
            except (FileNotFoundError, OSError, subprocess.SubprocessError):
                pass

        await asyncio.to_thread(_win)
        return
    try:
        os.kill(pid, 9)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def _write_config(token: str) -> Path:
    root = python_package_root()
    payload = {'token': token, 'python_path': [str(root)]}
    fd, name = tempfile.mkstemp(prefix='clara-admin-', suffix='.json')
    path = Path(name)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


async def _wait_port_file(path: Path, *, timeout: float, pid_dead: Any) -> tuple[int | None, int | None, str | None]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if callable(pid_dead) and pid_dead():
            return None, None, 'Elevated helper exited before it became ready (prompt cancelled or launch failed).'
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
                port = int(data['port'])
                pid = int(data['pid']) if data.get('pid') is not None else None
                if 1 <= port <= 65535:
                    return port, pid, None
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
                pass
        await asyncio.sleep(0.1)
    return None, None, 'Timed out waiting for the administrator / polkit helper to start.'


def _quote_win(value: str) -> str:
    if not value or any(ch in value for ch in ' \t"'):
        return '"' + value.replace('"', '\\"') + '"'
    return value


def _launch_windows_runas(python_exe: str, params: str, cwd: str) -> tuple[int | None, str | None]:
    import ctypes
    from ctypes import wintypes

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = (
            ('cbSize', wintypes.DWORD),
            ('fMask', wintypes.ULONG),
            ('hwnd', wintypes.HWND),
            ('lpVerb', wintypes.LPCWSTR),
            ('lpFile', wintypes.LPCWSTR),
            ('lpParameters', wintypes.LPCWSTR),
            ('lpDirectory', wintypes.LPCWSTR),
            ('nShow', ctypes.c_int),
            ('hInstApp', wintypes.HINSTANCE),
            ('lpIDList', ctypes.c_void_p),
            ('lpClass', wintypes.LPCWSTR),
            ('hkeyClass', wintypes.HKEY),
            ('dwHotKey', wintypes.DWORD),
            ('hIcon', wintypes.HANDLE),
            ('hProcess', wintypes.HANDLE),
        )

    see_mask_nocloseprocess = 0x00000040
    #: Required when calling from a thread that may exit before the operation
    #: completes (we run this in ``asyncio.to_thread``).
    see_mask_noasync = 0x00000100
    sw_hide = 0
    error_cancelled = 1223
    shell32 = ctypes.WinDLL('shell32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    shell32.ShellExecuteExW.argtypes = (ctypes.POINTER(SHELLEXECUTEINFOW),)
    shell32.ShellExecuteExW.restype = wintypes.BOOL
    kernel32.GetProcessId.argtypes = (wintypes.HANDLE,)
    kernel32.GetProcessId.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = see_mask_nocloseprocess | see_mask_noasync
    info.lpVerb = 'runas'
    info.lpFile = python_exe
    info.lpParameters = params
    info.lpDirectory = cwd
    info.nShow = sw_hide
    if not shell32.ShellExecuteExW(ctypes.byref(info)):
        err = ctypes.get_last_error()
        if err == error_cancelled:
            return None, 'User cancelled the administrator prompt.'
        return None, f'Tool error: failed to start elevated helper (Win32 error {err}).'
    pid = int(kernel32.GetProcessId(info.hProcess)) if info.hProcess else 0
    if info.hProcess:
        kernel32.CloseHandle(info.hProcess)
    return (pid or None), None


async def _launch_broker_process(config_path: Path, port_file: Path) -> tuple[int | None, str | None]:
    python_exe = sys.executable
    root = str(python_package_root())
    module_args = [
        '-u',
        '-m',
        'clara_coder_backend.runtime.admin_broker',
        '--config',
        str(config_path),
        '--port-file',
        str(port_file),
    ]
    if sys.platform == 'win32':
        params = ' '.join(
            [
                '-u',
                '-m',
                'clara_coder_backend.runtime.admin_broker',
                '--config',
                _quote_win(str(config_path)),
                '--port-file',
                _quote_win(str(port_file)),
            ]
        )
        pid, err = await asyncio.to_thread(_launch_windows_runas, python_exe, params, root)
        return pid, err

    pkexec = shutil.which('pkexec')
    if not pkexec:
        return None, (
            'Tool error: pkexec is not installed. Install policykit-1 '
            '(or run Clara as root) to run admin commands.'
        )
    env_bin = shutil.which('env') or '/usr/bin/env'
    try:
        # stderr is discarded on purpose: nobody drains it, and a PIPE that is
        # never read would block pkexec / the helper once the buffer fills.
        proc = await asyncio.create_subprocess_exec(
            pkexec,
            env_bin,
            f'PYTHONPATH={root}',
            python_exe,
            *module_args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError as exc:
        return None, f'Tool error: failed to start pkexec: {exc}'
    return proc.pid, None


async def _connect_broker(session_id: str, *, persist: bool, token: str, port: int, pid: int | None, config_path: Path, port_file: Path) -> tuple[BrokerClient | None, str | None]:
    try:
        reader, writer = await asyncio.open_connection('127.0.0.1', port)
    except OSError as exc:
        return None, f'Tool error: could not connect to elevated helper: {exc}'
    writer.write((json.dumps({'op': 'hello', 'token': token}, separators=(',', ':')) + '\n').encode('utf-8'))
    await writer.drain()
    raw = await asyncio.wait_for(reader.readline(), timeout=10.0)
    try:
        reply = json.loads(raw.decode('utf-8')) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        reply = {}
    if not isinstance(reply, dict) or reply.get('op') != 'hello_ok':
        try:
            writer.close()
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass
        return None, 'Tool error: elevated helper rejected the session token.'
    return (
        BrokerClient(
            session_id,
            persist=persist,
            reader=reader,
            writer=writer,
            pid=pid,
            config_path=config_path,
            port_file=port_file,
        ),
        None,
    )


async def ensure_session_broker(session_id: str, *, persist: bool) -> tuple[BrokerClient | None, str | None]:
    """Return a live broker for ``session_id``, launching one if needed.

    Serialized per session: concurrent callers wait for the first launch
    instead of each showing their own UAC / polkit prompt.
    """

    lock = _LAUNCH_LOCKS.setdefault(session_id, asyncio.Lock())
    async with lock:
        return await _ensure_session_broker_locked(session_id, persist=persist)


async def _ensure_session_broker_locked(
    session_id: str, *, persist: bool
) -> tuple[BrokerClient | None, str | None]:
    existing = _BROKERS.get(session_id)
    if existing is not None and existing._alive:
        if persist:
            existing.persist = True
        return existing, None

    token = secrets.token_hex(32)
    config_path = _write_config(token)
    fd, port_name = tempfile.mkstemp(prefix='clara-admin-port-', suffix='.json')
    os.close(fd)
    port_file = Path(port_name)
    try:
        port_file.unlink()
    except OSError:
        pass

    pid, launch_err = await _launch_broker_process(config_path, port_file)
    if launch_err:
        _cleanup_path(config_path)
        _cleanup_path(port_file)
        return None, launch_err

    def _pid_dead() -> bool:
        if not pid:
            return False
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes

            process_query_limited = 0x1000
            still_active = 259
            handle = ctypes.windll.kernel32.OpenProcess(process_query_limited, False, int(pid))
            if not handle:
                return True
            code = wintypes.DWORD()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(handle)
            return bool(ok) and int(code.value) != still_active
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            # pkexec has already become root: signalling it is denied, but it is alive.
            return False
        except OSError:
            return True
        return False

    port, ready_pid, wait_err = await _wait_port_file(
        port_file,
        timeout=_LAUNCH_TIMEOUT_SEC,
        pid_dead=_pid_dead,
    )
    if wait_err or port is None:
        _cleanup_path(config_path)
        _cleanup_path(port_file)
        if pid:
            await _kill_pid(pid)
        return None, wait_err or 'Tool error: elevated helper did not publish a port.'

    client, conn_err = await _connect_broker(
        session_id,
        persist=persist,
        token=token,
        port=port,
        pid=ready_pid or pid,
        config_path=config_path,
        port_file=port_file,
    )
    if conn_err or client is None:
        _cleanup_path(config_path)
        _cleanup_path(port_file)
        if pid:
            await _kill_pid(pid)
        return None, conn_err
    _BROKERS[session_id] = client
    return client, None


async def warmup_persistent_broker(session_id: str) -> str | None:
    """Launch (or reuse) the elevated helper so UAC/polkit happens at grant time.

    Returns an error string when the helper cannot start; ``None`` on success.
    Already-privileged Clara processes skip the helper.
    """

    if is_currently_privileged():
        return None
    if not admin_elevation_supported():
        return 'Tool error: admin commands are supported on Windows and Linux only.'
    client, err = await ensure_session_broker(session_id, persist=True)
    if err or client is None:
        return err or 'Tool error: elevated helper failed to start.'
    return None


async def start_elevated_job(
    session_id: str,
    *,
    job_id: str,
    command: str,
    cwd: str,
    env: dict[str, str] | None,
    persist: bool,
) -> tuple[ElevatedJobHandle | None, str | None]:
    """Start ``command`` on the session broker (UAC/polkit once per new helper)."""

    if not admin_elevation_supported():
        return None, 'Tool error: admin commands are supported on Windows and Linux only.'
    client, err = await ensure_session_broker(session_id, persist=persist)
    if err or client is None:
        return None, err
    handle = await client.start_job(job_id, command=command, cwd=cwd, env=env)
    return handle, None


async def shutdown_session_broker(session_id: str) -> None:
    """Stop the elevated helper for a chat session."""

    client = _BROKERS.pop(session_id, None)
    lock = _LAUNCH_LOCKS.get(session_id)
    if lock is not None and not lock.locked():
        _LAUNCH_LOCKS.pop(session_id, None)
    if client is None:
        return
    await client.close()


def broker_clients() -> dict[str, BrokerClient]:
    """Live broker map (tests / teardown)."""

    return _BROKERS


# Re-export for tests that import token compare from this module.
__all__ = [
    'BrokerClient',
    'ElevatedJobHandle',
    'admin_elevation_supported',
    'broker_clients',
    'elevation_privilege_label',
    'ensure_session_broker',
    'is_currently_privileged',
    'python_package_root',
    'shutdown_session_broker',
    'start_elevated_job',
    'warmup_persistent_broker',
]
