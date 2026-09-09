"""Shared download / extract / ready-marker / subprocess helpers for managed dependencies."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tarfile
import time
import zipfile
from collections.abc import Callable
from pathlib import Path
from urllib.request import Request, urlopen

from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.download')

READY_MARKER = '.clara-ready'

# Lines of child output kept for the error message when a streamed step fails.
_STREAM_ERROR_TAIL = 40


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
        )
    except (FileNotFoundError, OSError) as exc:
        PROGRESS.emit(dep_id, phase, message=f'{label} failed to start: {exc}')
        raise RuntimeError(f'{label} failed: {exc}') from exc

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

    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + '.partial')
    req = Request(url, headers={'User-Agent': 'ClaraCoder-deps/1.0'})
    try:
        with urlopen(req, timeout=timeout) as resp, partial.open('wb') as out:
            total_hdr = resp.headers.get('Content-Length')
            total = int(total_hdr) if total_hdr and total_hdr.isdigit() else None
            done = 0
            while True:
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

    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    name = archive.name.lower()
    if name.endswith('.zip'):
        with zipfile.ZipFile(archive, 'r') as zf:
            zf.extractall(dest)
        return
    with tarfile.open(archive, 'r:*') as tar:
        try:
            tar.extractall(dest, filter='data')
        except TypeError:
            tar.extractall(dest)


def chmod_executable(path: Path) -> None:
    try:
        mode = path.stat().st_mode
        path.chmod(mode | 0o111)
    except OSError as exc:
        logger.warning('could not chmod +x %s: %s', path, exc)
