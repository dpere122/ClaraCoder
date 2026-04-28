"""Workspace edit staging under ``NEMO_STAGING_DIR`` for nested create/update specialists."""

from __future__ import annotations

import hashlib
import logging
import os
import re
import tempfile
import uuid
from shutil import copy2
from pathlib import Path

from nemo_backend.lsp.file_policy import (
    CONFIG_CODE_REVIEW_EXTENSIONS,
    LEGACY_CODE_REVIEW_EXTENSIONS,
    requires_code_review,
)
from nemo_backend.workspace_ignore import get_workspace_ignore_rules_cached, should_ignore_workspace_entry
from nemo_backend.workspace_text_io import DiskNewline, decode_for_tools, encode_for_disk

logger = logging.getLogger('nemo.staging')

# Extensions that require code review before finalize (nested planning only).
CODE_REVIEW_EXTENSIONS: frozenset[str] = frozenset(
    {'.py', *LEGACY_CODE_REVIEW_EXTENSIONS, *CONFIG_CODE_REVIEW_EXTENSIONS}
)


def get_staging_root() -> Path:
    raw = os.environ.get('NEMO_STAGING_DIR', '').strip()
    if raw:
        return Path(raw).resolve()
    return Path(tempfile.gettempdir()).resolve() / 'nemo-wrapper-staging'


def is_code_review_extension(relative_posix_path: str) -> bool:
    return requires_code_review(relative_posix_path)


def _safe_staging_filename(rel_display: str) -> str:
    base = rel_display.strip().replace('\\', '/') or 'file'
    digest = hashlib.sha256(base.encode('utf-8')).hexdigest()[:16]
    leaf = Path(base).name
    leaf = re.sub(r'[^a-zA-Z0-9._-]+', '_', leaf)[:120] or 'file'
    return f'{digest}_{leaf}'


def _safe_staging_namespace(session_id: str, graph_id: str = '') -> str:
    base = re.sub(r'[^a-zA-Z0-9._-]+', '_', session_id)[:120] or 'session'
    if not graph_id:
        return base
    suffix = re.sub(r'[^a-zA-Z0-9._-]+', '_', graph_id)[:60] or 'graph'
    return f'{base}__{suffix}'


def _graph_session_dir(session_id: str, graph_id: str = '') -> Path:
    return get_staging_root() / _safe_staging_namespace(session_id, graph_id)


def graph_snapshot_root(session_id: str, graph_id: str) -> Path:
    return (_graph_session_dir(session_id, graph_id) / 'workspace-snapshot').resolve()


def allocate_staging_file(session_id: str, rel_display: str, *, graph_id: str = '') -> Path:
    session_dir = _graph_session_dir(session_id, graph_id) / 'drafts'
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


def format_python_source_str(text: str) -> tuple[str | None, str]:
    """Run Black on a source string. Returns ``(formatted, '')`` or ``(None, error_detail)``."""

    try:
        import black
    except ImportError:
        return None, 'black is not installed'
    try:
        formatted = black.format_str(text, mode=black.FileMode())
        return formatted, ''
    except Exception as exc:
        logger.warning('Black format_str failed err=%s', exc)
        return None, str(exc)


def run_black_on_file(path: Path, *, encoding: str, disk_newline: DiskNewline) -> tuple[bool, str]:
    """Run Black on ``path`` (in-memory format, then write). Returns (ok, detail)."""
    try:
        src = read_staging_text(path, encoding)
    except OSError as exc:
        return False, f'read failed: {exc}'

    formatted, err = format_python_source_str(src)
    if formatted is None:
        return False, err

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
    """Remove every staging namespace for ``session_id`` (best effort)."""
    root = get_staging_root()
    prefix = _safe_staging_namespace(session_id)
    try:
        if not root.is_dir():
            return
        for sub in root.iterdir():
            if not sub.is_dir() or not sub.name.startswith(prefix):
                continue
            for p in sorted(sub.rglob('*'), reverse=True):
                try:
                    if p.is_file():
                        p.unlink()
                    elif p.is_dir():
                        p.rmdir()
                except OSError:
                    pass
            try:
                sub.rmdir()
            except OSError:
                pass
    except OSError:
        pass


def copy_workspace_into_snapshot(workspace_root: Path, snapshot_root: Path) -> None:
    """Materialize an ignored-aware workspace mirror under ``snapshot_root``."""
    workspace_root = workspace_root.resolve()
    snapshot_root = snapshot_root.resolve()
    ignore_rules = get_workspace_ignore_rules_cached(workspace_root)
    snapshot_root.mkdir(parents=True, exist_ok=True)

    for dirpath, dirnames, filenames in os.walk(workspace_root, topdown=True):
        src_dir = Path(dirpath)
        rel_dir_raw = src_dir.relative_to(workspace_root).as_posix()
        rel_dir = '' if rel_dir_raw == '.' else rel_dir_raw

        kept_dirs: list[str] = []
        for dirname in dirnames:
            rel_path = f'{rel_dir}/{dirname}' if rel_dir else dirname
            if should_ignore_workspace_entry(dirname, rel_path, ignore_rules):
                continue
            kept_dirs.append(dirname)
            (snapshot_root / rel_path).mkdir(parents=True, exist_ok=True)
        dirnames[:] = kept_dirs

        for filename in filenames:
            rel_path = f'{rel_dir}/{filename}' if rel_dir else filename
            if should_ignore_workspace_entry(filename, rel_path, ignore_rules):
                continue
            source = src_dir / filename
            target = snapshot_root / rel_path
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                copy2(source, target)
            except OSError as exc:
                # Windows: junctions / reparse points / transient locks under .venv often make
                # copy2 fail with FileNotFoundError (WinError 3). One bad file must not abort
                # the whole planner snapshot (plan_and_modify).
                logger.warning(
                    'workspace snapshot: skipped copy (unreadable or uncopyable) rel=%s err=%s',
                    rel_path,
                    exc,
                )


def begin_planner_graph_staging_session(session: object, session_id: str, workspace_root: Path) -> str:
    """Reset planner-local staging state, then seed a fresh workspace snapshot for a new graph."""
    discard_all_session_stagings(session)
    setattr(session, 'test_run_materializations', {})
    clear_session_staging_dir(session_id)

    graph_id = uuid.uuid4().hex[:12]
    snapshot_root = graph_snapshot_root(session_id, graph_id)
    copy_workspace_into_snapshot(workspace_root, snapshot_root)

    setattr(session, 'active_planner_graph_id', graph_id)
    setattr(session, 'active_planner_snapshot_root', str(snapshot_root))
    return graph_id


def get_active_planner_snapshot_root(session: object) -> Path | None:
    raw = str(getattr(session, 'active_planner_snapshot_root', '') or '').strip()
    if not raw:
        return None
    return Path(raw).resolve()


def write_snapshot_file(session: object, relative_path: str, text: str, encoding: str, disk_newline: DiskNewline) -> None:
    """Keep the active planner snapshot in sync with the latest approved or staged file content."""
    snapshot_root = get_active_planner_snapshot_root(session)
    if snapshot_root is None:
        return
    rel = relative_path.strip().replace('\\', '/')
    if not rel:
        return
    target = (snapshot_root / rel).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    write_staging_text(target, text, encoding, disk_newline)


def delete_snapshot_path(session: object, relative_path: str) -> None:
    """Remove a path from the active planner snapshot when the real workspace deletes it."""
    snapshot_root = get_active_planner_snapshot_root(session)
    if snapshot_root is None:
        return
    rel = relative_path.strip().replace('\\', '/')
    if not rel:
        return
    target = (snapshot_root / rel).resolve()
    if target.is_file() or target.is_symlink():
        unlink_staging_quiet(target)
    current = target.parent
    while current != snapshot_root and current.is_dir():
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent
