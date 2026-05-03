"""Ephemeral workspace mirror + staged drafts for pre-transfer command runs."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from nemo_backend.edit_staging import (
    copy_workspace_mirror,
    get_active_planner_snapshot_root,
    get_staging_root,
)
from nemo_backend.workspace_text_io import DiskNewline, write_file_resolved

if TYPE_CHECKING:
    from nemo_backend.domain import SessionState

logger = logging.getLogger('nemo.staging_overlay')

_DEFAULT_LINK_RELS: tuple[str, ...] = (
    '.venv',
    'node_modules',
    'python/node_modules',
    'src/renderer/node_modules',
)


def _safe_session_ns(session_id: str) -> str:
    return re.sub(r'[^a-zA-Z0-9._-]+', '_', session_id)[:120] or 'session'


def _link_dir_windows_junction(target: Path, link: Path) -> tuple[bool, str]:
    target_s = str(target.resolve())
    link_s = str(link.resolve())
    try:
        proc = subprocess.run(
            ['cmd', '/c', 'mklink', '/J', link_s, target_s],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0:
            return True, ''
        err = (proc.stderr or proc.stdout or '').strip() or f'exit {proc.returncode}'
        return False, err
    except OSError as exc:
        return False, str(exc)


def link_workspace_dependency_into_overlay(
    workspace_root: Path,
    overlay_root: Path,
    rel_posix: str,
) -> tuple[bool, str]:
    """Point overlay_root/rel at workspace_root/rel when the source exists (symlink or Windows junction)."""
    rel = rel_posix.strip().replace('\\', '/').strip('/')
    if not rel or '..' in rel.split('/'):
        return False, f'Invalid dependency relative path `{rel_posix}`.'
    ws_resolved = workspace_root.resolve()
    ov_resolved = overlay_root.resolve()
    src = (ws_resolved / rel).resolve()
    dst = (ov_resolved / rel).resolve()
    try:
        dst.relative_to(ov_resolved)
    except ValueError:
        return False, 'Overlay link path escapes overlay root.'
    try:
        src.relative_to(ws_resolved)
    except ValueError:
        return False, 'Dependency link source escapes workspace root.'
    if not src.exists():
        return True, ''
    if dst.exists() or dst.is_symlink():
        return True, ''
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.symlink(src, dst, target_is_directory=src.is_dir())
        return True, ''
    except OSError as exc:
        if sys.platform.startswith('win') and src.is_dir():
            ok, detail = _link_dir_windows_junction(src, dst)
            if ok:
                return True, ''
            return False, f'Could not symlink or junction `{rel}`: {exc}; {detail}'
        return False, f'Could not symlink `{rel}`: {exc}'


def _workspace_applied(entry: object) -> bool:
    v = getattr(entry, 'workspace_applied', False)
    return v if isinstance(v, bool) else False


def apply_pending_staged_merged_texts(session: SessionState, overlay_root: Path) -> tuple[bool, str]:
    """Write each pending staging draft into the overlay mirror."""
    overlay_resolved = overlay_root.resolve()
    pending = getattr(session, 'pending_edit_stagings', None)
    if not isinstance(pending, dict):
        return True, ''
    for rel_key, entry in list(pending.items()):
        if _workspace_applied(entry):
            continue
        rel = str(rel_key).strip().replace('\\', '/')
        if not rel or '..' in rel.split('/'):
            return False, f'Invalid staged path `{rel_key}`.'
        target = (overlay_resolved / rel).resolve()
        try:
            target.relative_to(overlay_resolved)
        except ValueError:
            return False, f'Staged path `{rel}` escapes overlay root.'
        merged = str(getattr(entry, 'merged_text', '') or '')
        enc = str(getattr(entry, 'disk_encoding', '') or 'utf-8')
        nl_raw = str(getattr(entry, 'disk_newline', '') or 'lf').lower()
        nl: DiskNewline = 'crlf' if nl_raw == 'crlf' else 'lf'
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            write_file_resolved(target, merged, enc, nl)
        except OSError as exc:
            return False, f'Could not write staged overlay for `{rel}`: {exc}'
        except Exception as exc:
            return False, f'Could not encode staged overlay for `{rel}`: {exc}'
    return True, ''


def build_staging_workspace_overlay(
    session: SessionState,
    workspace_root: Path,
    session_id: str,
    *,
    overlay_subdir: str,
    extra_dependency_rels: tuple[str, ...] | None = None,
) -> tuple[Path | None, Path | None, str]:
    """Return ``(overlay_root, overlay_parent, err)``; ``overlay_parent`` is the uuid folder to rmtree.

    Baseline tree is the active planner snapshot when present, else the live workspace.
    ``overlay_root`` is ``.../uuid/workspace`` — the synthetic workspace root (LSP rootUri / subprocess cwd).
    """
    ws = workspace_root.resolve()
    snap = get_active_planner_snapshot_root(session)
    content_root = snap if snap is not None and snap.is_dir() else ws
    ns = _safe_session_ns(session_id)
    overlay_parent = get_staging_root() / ns / overlay_subdir / uuid.uuid4().hex
    overlay_root = overlay_parent / 'workspace'
    try:
        overlay_root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return None, None, f'Could not create overlay directory ({exc}).'

    try:
        copy_workspace_mirror(content_root, overlay_root, rules_workspace=ws)
        ordered: list[str] = []
        seen: set[str] = set()
        for rel in (*_DEFAULT_LINK_RELS, *(extra_dependency_rels or ())):
            rel_clean = rel.strip().replace('\\', '/').strip('/')
            if not rel_clean or rel_clean in seen:
                continue
            seen.add(rel_clean)
            ordered.append(rel_clean)
        for rel_clean in ordered:
            ok, msg = link_workspace_dependency_into_overlay(ws, overlay_root, rel_clean)
            if not ok:
                shutil.rmtree(overlay_parent, ignore_errors=True)
                return None, None, msg or f'Failed to link dependency `{rel_clean}`.'
        ok2, err2 = apply_pending_staged_merged_texts(session, overlay_root)
        if not ok2:
            shutil.rmtree(overlay_parent, ignore_errors=True)
            return None, None, err2
    except Exception as exc:
        shutil.rmtree(overlay_parent, ignore_errors=True)
        logger.exception('build_staging_workspace_overlay failed subdir=%s', overlay_subdir)
        return None, None, str(exc)

    return overlay_root, overlay_parent, ''


def build_staging_test_overlay(
    session: SessionState,
    workspace_root: Path,
    session_id: str,
    *,
    extra_dependency_rels: tuple[str, ...] | None = None,
) -> tuple[Path | None, Path | None, str]:
    """Return ``(overlay_root, overlay_parent, err)``; ``overlay_parent`` is the uuid folder to rmtree.

    ``overlay_root`` is ``.../uuid/workspace`` — the synthetic workspace root for subprocess ``cwd``.
    """
    return build_staging_workspace_overlay(
        session,
        workspace_root,
        session_id,
        overlay_subdir='test-overlay',
        extra_dependency_rels=extra_dependency_rels,
    )


def remove_overlay_parent(overlay_parent: Path | None) -> None:
    if overlay_parent is None:
        return
    try:
        shutil.rmtree(overlay_parent, ignore_errors=True)
    except OSError:
        pass


def clear_lsp_staging_overlay(session: SessionState) -> None:
    """Remove on-disk LSP overlay and clear session pointers."""

    raw = str(getattr(session, 'lsp_staging_overlay_parent', '') or '').strip()
    if raw:
        remove_overlay_parent(Path(raw))
    session.lsp_staging_overlay_root = ''
    session.lsp_staging_overlay_parent = ''


def ensure_lsp_staging_overlay(session: SessionState, workspace_root: Path, *, session_id: str | None = None) -> Path:
    """Return the overlay workspace root, refreshing merged staging files on disk."""

    from nemo_backend.state import current_session_id

    sid = (session_id or current_session_id.get() or '').strip()
    if not sid:
        raise ValueError('No active session for LSP staging overlay.')
    ws = workspace_root.resolve()
    existing = str(getattr(session, 'lsp_staging_overlay_root', '') or '').strip()
    if existing:
        root = Path(existing)
        if root.is_dir():
            ok, err = apply_pending_staged_merged_texts(session, root)
            if ok:
                return root.resolve()
            logger.warning('lsp staging overlay incremental refresh failed; rebuilding: %s', err)
            clear_lsp_staging_overlay(session)

    overlay_root, overlay_parent, err_msg = build_staging_workspace_overlay(
        session,
        ws,
        sid,
        overlay_subdir='lsp-overlay',
    )
    if overlay_root is None or err_msg:
        raise ValueError(err_msg or 'Could not build LSP staging overlay.')
    session.lsp_staging_overlay_root = str(overlay_root.resolve())
    session.lsp_staging_overlay_parent = str(overlay_parent.resolve()) if overlay_parent else ''
    return overlay_root.resolve()


def parse_command_argv_json(raw: str) -> tuple[list[str] | None, str]:
    """Parse ``command_argv_json`` as a JSON array of strings for ``create_subprocess_exec``."""
    s = (raw or '').strip()
    if not s:
        return None, 'Tool error: command_argv_json is empty.'
    try:
        parsed = json.loads(s)
    except json.JSONDecodeError as exc:
        return None, f'Tool error: command_argv_json is not valid JSON ({exc}).'
    if not isinstance(parsed, list):
        return None, 'Tool error: command_argv_json must be a JSON array of strings.'
    argv: list[str] = []
    for i, item in enumerate(parsed):
        if not isinstance(item, str):
            return None, f'Tool error: argv[{i}] must be a string.'
        if item == '':
            return None, f'Tool error: argv[{i}] is empty.'
        argv.append(item)
    if not argv:
        return None, 'Tool error: command argv must be non-empty.'
    return argv, ''


def resolve_overlay_cwd(overlay_root: Path, cwd_relative: str) -> tuple[Path | None, str]:
    """Resolve ``cwd_relative`` (posix, relative to overlay root) to an absolute cwd under the overlay."""
    rel = (cwd_relative or '').strip().replace('\\', '/').strip('/')
    ov = overlay_root.resolve()
    if not rel:
        return ov, ''
    if '..' in rel.split('/'):
        return None, 'Tool error: cwd_relative must not contain `..`.'
    cwd = (ov / rel).resolve()
    try:
        cwd.relative_to(ov)
    except ValueError:
        return None, 'Tool error: cwd_relative escapes the overlay root.'
    return cwd, ''
