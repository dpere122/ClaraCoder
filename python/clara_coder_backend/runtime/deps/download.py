"""Shared download / extract / ready-marker / subprocess helpers for managed dependencies."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
from collections.abc import Callable
from pathlib import Path
from urllib.request import Request, urlopen

from clara_coder_backend.runtime.deps.cancel import current, is_cancelled, raise_if_cancelled
from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.download')

READY_MARKER = '.clara-ready'

# Lines of child output kept for the error message when a streamed step fails.
_STREAM_ERROR_TAIL = 40
# How often a running child is checked for a cancel request.
_CANCEL_POLL_S = 0.25


def terminate_process_tree(proc: subprocess.Popen) -> None:
    """Stop ``proc`` and its children (pip / cmake spawn helpers that a plain kill would orphan)."""

    if proc.poll() is not None:
        return
    try:
        if sys.platform == 'win32':
            subprocess.run(
                ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                capture_output=True,
                timeout=15,
                check=False,
            )
        else:
            import signal

            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning('could not stop process tree %s: %s', proc.pid, exc)
    finally:
        if proc.poll() is None:
            proc.kill()


def _stop_on_cancel(proc: subprocess.Popen, dep_id: str | None) -> threading.Thread | None:
    """Watch for a cancel request while ``proc`` runs (its output may be silent for minutes)."""

    if dep_id is None:
        return None

    def _watch() -> None:
        while proc.poll() is None:
            if is_cancelled(dep_id):
                logger.info('cancel requested for %s; stopping pid %s', dep_id, proc.pid)
                terminate_process_tree(proc)
                return
            time.sleep(_CANCEL_POLL_S)

    watcher = threading.Thread(target=_watch, name=f'deps-cancel-{dep_id}', daemon=True)
    watcher.start()
    return watcher


def run_streaming(
    cmd: list[str],
    *,
    dep_id: str,
    label: str,
    phase: str = 'installing',
    timeout: float | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
    echo_command: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run ``cmd`` and forward every stdout/stderr line to the progress bus.

    Each non-empty output line becomes a ``phase`` progress event for ``dep_id``
    with the line as the message, so the Dependencies window install log shows the
    child's live output (pip downloads, venv/ensurepip chatter, …) instead of a
    single static status line.

    Returns a ``CompletedProcess`` whose ``stdout`` is the merged output. When
    ``check`` is true a non-zero exit raises ``RuntimeError`` carrying the last
    few lines of output.
    """

    logger.info('%s: %s', label, ' '.join(cmd))
    if echo_command:
        PROGRESS.emit(dep_id, phase, message='$ ' + ' '.join(cmd))

    child_env = dict(os.environ if env is None else env)
    # Flush promptly and emit UTF-8 so the log stays live and decodable on Windows.
    child_env.setdefault('PYTHONUNBUFFERED', '1')
    child_env.setdefault('PYTHONIOENCODING', 'utf-8')

    # Cancel follows the install that is running (Kokoro's pip step is labelled python-runtime).
    cancel_id = current() or dep_id
    raise_if_cancelled(cancel_id)
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,
            env=child_env,
            # Own process group on POSIX so a cancel can stop the whole tree.
            start_new_session=sys.platform != 'win32',
        )
    except (FileNotFoundError, OSError) as exc:
        PROGRESS.emit(dep_id, phase, message=f'{label} failed to start: {exc}')
        raise RuntimeError(f'{label} failed: {exc}') from exc

    _stop_on_cancel(proc, cancel_id)
    assert proc.stdout is not None
    collected: list[str] = []
    for line in proc.stdout:
        stripped = line.rstrip('\r\n')
        if stripped.strip():
            collected.append(stripped)
            PROGRESS.emit(dep_id, phase, message=stripped)
    proc.stdout.close()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        PROGRESS.emit(dep_id, phase, message=f'{label} timed out after {timeout}s')
        raise RuntimeError(f'{label} timed out after {timeout}s')

    raise_if_cancelled(cancel_id)
    output = '\n'.join(collected)
    if proc.returncode != 0:
        PROGRESS.emit(dep_id, phase, message=f'{label} exited with code {proc.returncode}')
        if check:
            tail = '\n'.join(collected[-_STREAM_ERROR_TAIL:])
            raise RuntimeError(f'{label} failed with exit code {proc.returncode}\n{tail}')
    return subprocess.CompletedProcess(cmd, proc.returncode, output, '')


def download_file(
    url: str,
    dest: Path,
    *,
    on_progress: Callable[[int, int | None], None] | None = None,
    timeout: int = 120,
) -> None:
    """Download ``url`` to ``dest`` via a ``.partial`` file, reporting byte progress."""

    raise_if_cancelled()
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + '.partial')
    req = Request(url, headers={'User-Agent': 'ClaraCoder-deps/1.0'})
    try:
        with urlopen(req, timeout=timeout) as resp, partial.open('wb') as out:
            total_hdr = resp.headers.get('Content-Length')
            total = int(total_hdr) if total_hdr and total_hdr.isdigit() else None
            done = 0
            while True:
                raise_if_cancelled()
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if on_progress:
                    on_progress(done, total)
        partial.replace(dest)
    except Exception:
        if partial.exists():
            try:
                partial.unlink()
            except OSError:
                pass
        raise


def _pid_is_alive(pid: int) -> bool:
    """Return True if ``pid`` refers to a running process."""

    if pid <= 0:
        return False
    if sys.platform == 'win32':
        # ``os.kill(pid, 0)`` is NOT a probe on Windows: it calls TerminateProcess
        # and would kill the lock holder. Query the process instead.
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        handle = kernel32.OpenProcess(process_query_limited_information, False, int(pid))
        if not handle:
            # ERROR_ACCESS_DENIED (5): exists but not ours; anything else: gone.
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return not ok or int(code.value) == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but we cannot signal it — treat as alive.
        return True
    return True


def _reclaim_stale_lock(lock_path: Path) -> bool:
    """Unlink ``lock_path`` when it has no living holder. Returns True if removed.

    Lock files written by this module contain the holder PID. Empty / unparseable
    locks (left by older code or a hard kill before the PID was written) are also
    treated as stale so a crashed install cannot block retries forever.
    """

    try:
        text = lock_path.read_text(encoding='utf-8').strip()
    except OSError:
        return False

    if text:
        try:
            pid = int(text.split()[0])
        except ValueError:
            pid = None
        if pid is not None and _pid_is_alive(pid):
            return False

    try:
        lock_path.unlink()
        logger.info('reclaimed stale download lock at %s', lock_path)
        return True
    except OSError:
        return False


def with_download_lock(lock_path: Path, *, ready_check: Callable[[], bool], wait_s: float = 60.0):
    """Exclusive file lock. Yields an object with ``.held`` True when we own it.

    The lock file stores the holder PID so a crashed / killed installer cannot
    leave a permanent block. Concurrent waiters poll until the holder finishes,
    the ready-check succeeds, or ``wait_s`` elapses.
    """

    class _Lock:
        held = False

        def __enter__(self):
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            deadline = time.time() + wait_s
            while time.time() < deadline:
                try:
                    fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    try:
                        os.write(fd, f'{os.getpid()}\n'.encode('ascii'))
                    finally:
                        os.close(fd)
                    self.held = True
                    return self
                except FileExistsError:
                    if ready_check():
                        return self
                    if _reclaim_stale_lock(lock_path):
                        continue
                    time.sleep(0.5)
            if ready_check():
                return self
            # Last chance: holder may have died after the wait loop started.
            if _reclaim_stale_lock(lock_path):
                try:
                    fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    try:
                        os.write(fd, f'{os.getpid()}\n'.encode('ascii'))
                    finally:
                        os.close(fd)
                    self.held = True
                    return self
                except FileExistsError:
                    if ready_check():
                        return self
            raise TimeoutError(f'Timed out waiting for download lock at {lock_path}')

        def __exit__(self, *exc):
            if self.held:
                try:
                    lock_path.unlink(missing_ok=True)
                except OSError:
                    pass
            return False

    return _Lock()


def write_ready_marker(dir_path: Path, version: str) -> None:
    dir_path.mkdir(parents=True, exist_ok=True)
    (dir_path / READY_MARKER).write_text(version + '\n', encoding='utf-8')


def read_ready_marker(dir_path: Path) -> str | None:
    marker = dir_path / READY_MARKER
    if not marker.is_file():
        return None
    text = marker.read_text(encoding='utf-8').strip()
    return text or None


def extract_archive(archive: Path, dest: Path) -> None:
    """Extract tar.gz / zip into ``dest`` (created fresh)."""

    raise_if_cancelled()
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    name = archive.name.lower()
    # Member by member so a cancel stops large archives (CUDA builds) between files.
    if name.endswith('.zip'):
        with zipfile.ZipFile(archive, 'r') as zf:
            for member in zf.infolist():
                raise_if_cancelled()
                zf.extract(member, dest)
        return
    with tarfile.open(archive, 'r:*') as tar:
        for member in tar:
            raise_if_cancelled()
            try:
                tar.extract(member, dest, filter='data')
            except TypeError:
                tar.extract(member, dest)


def chmod_executable(path: Path) -> None:
    try:
        mode = path.stat().st_mode
        path.chmod(mode | 0o111)
    except OSError as exc:
        logger.warning('could not chmod +x %s: %s', path, exc)
