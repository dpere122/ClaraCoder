"""Shared download / extract / ready-marker helpers for managed dependencies."""

from __future__ import annotations

import logging
import os
import shutil
import tarfile
import time
import zipfile
from collections.abc import Callable
from pathlib import Path
from urllib.request import Request, urlopen

logger = logging.getLogger('clara.runtime.deps.download')

READY_MARKER = '.clara-ready'


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


def with_download_lock(lock_path: Path, *, ready_check: Callable[[], bool], wait_s: float = 60.0):
    """Context-manager-like lock using an exclusive file. Yields whether we hold the lock."""

    class _Lock:
        held = False

        def __enter__(self):
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            deadline = time.time() + wait_s
            while time.time() < deadline:
                try:
                    fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.close(fd)
                    self.held = True
                    return self
                except FileExistsError:
                    if ready_check():
                        return self
                    time.sleep(0.5)
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
