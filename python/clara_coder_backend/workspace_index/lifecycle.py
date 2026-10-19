"""Disk layout and invalidation for the workspace semantic index."""

from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

from clara_coder_backend.workspace_index.paths import (
    semantic_index_base_dir,
    staging_index_persist_dir,
    workspace_index_persist_dir,
)

logger = logging.getLogger('clara.workspace_index.lifecycle')

# ``root_str -> (monotonic_time, fingerprint)`` to avoid re-walking huge trees on every tool call.
_fingerprint_cache: dict[str, tuple[float, str]] = {}
_FINGERPRINT_TTL_SEC = 45.0
_FINGERPRINT_CACHE_MAX_ENTRIES = 512


def _prune_expired_fingerprint_entries(now: float) -> None:
    """Drop TTL-expired entries so fingerprint dicts do not grow without bound."""
    ttl = _FINGERPRINT_TTL_SEC
    stale = [k for k, (ts, _fp) in _fingerprint_cache.items() if (now - ts) >= ttl]
    for k in stale:
        _fingerprint_cache.pop(k, None)


def _evict_oldest_fingerprint_entries(cache: dict[str, tuple[float, str]], max_entries: int) -> None:
    """If over ``max_entries``, remove entries with the oldest monotonic timestamps."""
    while len(cache) > max_entries:
        oldest_key = min(cache.items(), key=lambda kv: kv[1][0])[0]
        cache.pop(oldest_key, None)


def invalidate_fingerprint_cache_for_root(workspace_root: Path) -> None:
    prefix = str(workspace_root.resolve())
    for k in list(_fingerprint_cache):
        if k == prefix or k.startswith(f'{prefix}\0'):
            _fingerprint_cache.pop(k, None)


def cached_workspace_fingerprint(workspace_root: Path, *, max_files: int) -> str:
    """Return a content fingerprint, recomputing at most once per TTL per workspace root."""
    root = workspace_root.resolve()
    key = f'{root}\0{max_files}'
    now = time.monotonic()
    _prune_expired_fingerprint_entries(now)
    hit = _fingerprint_cache.get(key)
    if hit is not None and (now - hit[0]) < _FINGERPRINT_TTL_SEC:
        return hit[1]
    from clara_coder_backend.workspace_index.fingerprint import workspace_content_fingerprint

    fp = workspace_content_fingerprint(root, max_files=max_files)
    _fingerprint_cache[key] = (now, fp)
    _evict_oldest_fingerprint_entries(_fingerprint_cache, _FINGERPRINT_CACHE_MAX_ENTRIES)
    return fp


def invalidate_workspace_index_disk(
    workspace_id: str = '',
    workspace_root: Path | None = None,
) -> None:
    """Remove persisted **internal** workspace corpus (and its in-memory copy) for the given workspace root."""
    from clara_coder_backend.workspace_index.docstore import release_index_dir
    from clara_coder_backend.workspace_index.index_build import forget_loaded_index

    if workspace_root is not None:
        root = workspace_root.resolve()
        pdir = workspace_index_persist_dir(workspace_id, root)
        forget_loaded_index(pdir)
        release_index_dir(pdir)
        if pdir.is_dir():
            shutil.rmtree(pdir, ignore_errors=True)
            logger.info('Removed semantic workspace index directory %s', pdir)
        invalidate_fingerprint_cache_for_root(root)
        return
    wid = (workspace_id or '').strip()
    if not wid:
        return
    base = semantic_index_base_dir() / 'workspaces'
    safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in wid)[:200] or 'workspace'
    pdir = base / safe
    forget_loaded_index(pdir)
    release_index_dir(pdir)
    if pdir.is_dir():
        shutil.rmtree(pdir, ignore_errors=True)
        logger.info('Removed semantic workspace index directory %s', pdir)


def invalidate_staging_index_disk(session_id: str) -> None:
    """Remove legacy persisted staging index for a chat session (staging is no longer indexed)."""
    sid = (session_id or '').strip()
    if not sid:
        return
    pdir = staging_index_persist_dir(sid)
    if pdir.is_dir():
        shutil.rmtree(pdir, ignore_errors=True)
        logger.info('Removed legacy staging semantic index directory %s', pdir)
