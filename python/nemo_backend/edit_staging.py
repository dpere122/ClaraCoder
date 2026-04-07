"""Workspace edit staging under ``NEMO_STAGING_DIR`` for nested create/update specialists."""

from __future__ import annotations

import hashlib
import logging
import os
import re
import tempfile
from pathlib import Path

from nemo_backend.workspace_text_io import DiskNewline, decode_for_tools, encode_for_disk

logger = logging.getLogger('nemo.staging')

# Extensions that require code review before finalize (nested planning only).
CODE_REVIEW_EXTENSIONS: frozenset[str] = frozenset(
    {
        '.py',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.go',
        '.rs',
        '.java',
        '.cs',
        '.rb',
        '.php',
        '.kt',
        '.kts',
        '.swift',
        '.vue',
        '.svelte',
        '.scala',
        '.c',
        '.h',
        '.cpp',
        '.hpp',
        '.cc',
        '.cxx',
        '.m',
        '.mm',
    }
)


def get_staging_root() -> Path:
    raw = os.environ.get('NEMO_STAGING_DIR', '').strip()
    if raw:
        return Path(raw).resolve()
    return Path(tempfile.gettempdir()).resolve() / 'nemo-wrapper-staging'


def is_code_review_extension(relative_posix_path: str) -> bool:
    lower = relative_posix_path.strip().replace('\\', '/').lower()
    for ext in CODE_REVIEW_EXTENSIONS:
        if lower.endswith(ext):
            return True
    return False


def _safe_staging_filename(rel_display: str) -> str:
    base = rel_display.strip().replace('\\', '/') or 'file'
    digest = hashlib.sha256(base.encode('utf-8')).hexdigest()[:16]
    leaf = Path(base).name
    leaf = re.sub(r'[^a-zA-Z0-9._-]+', '_', leaf)[:120] or 'file'
    return f'{digest}_{leaf}'


def allocate_staging_file(session_id: str, rel_display: str) -> Path:
    root = get_staging_root()
    session_dir = root / re.sub(r'[^a-zA-Z0-9._-]+', '_', session_id)[:200]
    session_dir.mkdir(parents=True, exist_ok=True)
    path = session_dir / _safe_staging_filename(rel_display)
    return path.resolve()


def write_staging_text(path: Path, text: str, encoding: str, disk_newline: DiskNewline) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = encode_for_disk(text, encoding, disk_newline)
    path.write_bytes(data)


def read_staging_text(path: Path, encoding: str) -> str:
    raw = path.read_bytes()
    return decode_for_tools(raw, encoding)


def run_black_on_file(path: Path, *, encoding: str, disk_newline: DiskNewline) -> tuple[bool, str]:
    """Run Black on ``path`` (UTF-8 round-trip through Black). Returns (ok, detail)."""
    try:
        import black
    except ImportError:
        return False, 'black is not installed'

    try:
        src = read_staging_text(path, encoding)
    except OSError as exc:
        return False, f'read failed: {exc}'

    try:
        mode = black.FileMode()
        formatted = black.format_str(src, mode=mode)
    except Exception as exc:
        logger.warning('Black format failed path=%s err=%s', path, exc)
        return False, str(exc)

    try:
        write_staging_text(path, formatted, encoding, disk_newline)
    except OSError as exc:
        return False, f'write failed: {exc}'
    return True, 'formatted'


def unlink_staging_quiet(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def discard_all_session_stagings(session: object) -> None:
    """Remove all pending staging entries for a session (unlink temps, clear dict)."""
    from pathlib import Path

    pending = getattr(session, 'pending_edit_stagings', None)
    if not isinstance(pending, dict):
        return
    for _rel, entry in list(pending.items()):
        tp = getattr(entry, 'temp_path', '') or ''
        if tp:
            unlink_staging_quiet(Path(tp))
    pending.clear()


def clear_session_staging_dir(session_id: str) -> None:
    """Remove the session's staging subdirectory (best effort)."""
    root = get_staging_root()
    sub = root / re.sub(r'[^a-zA-Z0-9._-]+', '_', session_id)[:200]
    try:
        if sub.is_dir():
            for p in sorted(sub.rglob('*'), reverse=True):
                try:
                    if p.is_file():
                        p.unlink()
                    elif p.is_dir():
                        p.rmdir()
                except OSError:
                    pass
            sub.rmdir()
    except OSError:
        pass
