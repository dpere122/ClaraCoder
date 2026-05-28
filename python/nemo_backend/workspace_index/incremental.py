"""Incremental semantic index updates from debounced file watcher batches."""

from __future__ import annotations

import logging
import threading
from itertools import zip_longest
from pathlib import Path
from typing import Any

from nemo_backend.config import NEMO_LLAMA_INDEX_MAX_FILES
from nemo_backend.domain import SessionState
from nemo_backend.workspace_index.fingerprint import workspace_content_fingerprint
from nemo_backend.workspace_index.index_build import (
    DOC_REF_STAGING,
    DOC_REF_WORKSPACE,
    manifest_embedding_model_id,
    load_or_rebuild_staging_index,
    load_or_rebuild_workspace_index,
    nodes_from_file_for_staging,
    nodes_from_file_for_workspace,
    write_staging_manifest,
    write_workspace_manifest,
)
from nemo_backend.workspace_index.lifecycle import (
    invalidate_fingerprint_cache_for_root,
    invalidate_fingerprint_cache_for_staging,
)
from nemo_backend.workspace_index.paths import staging_index_persist_dir, workspace_index_persist_dir
from nemo_backend.workspace_index.staging_fingerprint import staging_content_fingerprint
from nemo_backend.workspace_index.staging_walk import staging_session_roots
from nemo_backend.workspace_index.walk import is_indexable_workspace_relative_path

logger = logging.getLogger('nemo.workspace_index.incremental')

_STAGING_PREFIX = '[staging] '
# Coalesce rapid workspace-context sync batches before hitting the embeddings server.
_BACKGROUND_INDEX_DEBOUNCE_SEC = 2.0

_registry_lock = threading.Lock()
_workspace_locks: dict[str, threading.Lock] = {}
_staging_locks: dict[str, threading.Lock] = {}
_background_index_lock = threading.Lock()
_background_index_jobs: dict[str, dict[str, bool]] = {}
_background_index_timers: dict[str, threading.Timer] = {}


def _lock_for(store: dict[str, threading.Lock], key: str) -> threading.Lock:
    with _registry_lock:
        if key not in store:
            store[key] = threading.Lock()
        return store[key]


def _workspace_lock_key(workspace_id: str, root: Path) -> str:
    return f'w:{workspace_index_persist_dir(workspace_id, root)}'


def _staging_lock_key(session_id: str) -> str:
    return f's:{staging_index_persist_dir(session_id)}'


def schedule_semantic_index_background(session_id: str, *, ensure_corpus: bool = False) -> None:
    """Debounced background flush/build so embeddings index the workspace without blocking HTTP sync."""
    sid = (session_id or '').strip()
    if not sid:
        return
    with _background_index_lock:
        job = _background_index_jobs.setdefault(sid, {'ensure_corpus': False})
        job['ensure_corpus'] = job['ensure_corpus'] or bool(ensure_corpus)
        existing = _background_index_timers.pop(sid, None)
        if existing is not None:
            existing.cancel()

        def _fire() -> None:
            with _background_index_lock:
                _background_index_timers.pop(sid, None)
                job_state = _background_index_jobs.pop(sid, None) or {'ensure_corpus': False}
            try:
                _run_semantic_index_background(sid, ensure_corpus=bool(job_state.get('ensure_corpus')))
            except Exception:
                logger.debug('background semantic index failed session=%s', sid, exc_info=True)

        timer = threading.Timer(_BACKGROUND_INDEX_DEBOUNCE_SEC, _fire)
        timer.daemon = True
        _background_index_timers[sid] = timer
        timer.start()


def _run_semantic_index_background(session_id: str, *, ensure_corpus: bool) -> None:
    from nemo_backend.state import get_active_connection, get_session
    from nemo_backend.workspace_index.embeddings_factory import build_embedding_model, resolve_embedding_model_id

    sess = get_session(session_id)
    root_s = (sess.workspace_path or '').strip()
    if not root_s:
        return

    conn = get_active_connection()
    mid = resolve_embedding_model_id(conn)
    embed_model, err = build_embedding_model(conn)
    if embed_model is None:
        logger.debug('background semantic index skipped session=%s: %s', session_id, err)
        return

    root = Path(root_s).resolve()
    wid = (sess.workspace_id or '').strip()

    if sess.semantic_index_pending:
        flush_semantic_index_patches(session_id, sess, root, wid, embed_model, embedding_model_id=mid)

    if ensure_corpus:
        _, w_err = load_or_rebuild_workspace_index(
            root,
            wid,
            embed_model,
            fingerprint_override=None,
            embedding_model_id=mid,
        )
        if w_err:
            logger.debug('background semantic corpus build skipped session=%s: %s', session_id, w_err)


def enqueue_semantic_index_changes(sess: SessionState, paths: list[str], kinds: list[str]) -> None:
    """Append deduplicated watcher paths (latest kind wins). Capped to avoid unbounded growth."""
    merged: dict[str, str] = {}
    for p, k in zip_longest(paths or [], kinds or [], fillvalue='updated'):
        raw = (p or '').strip()
        if not raw:
            continue
        merged[raw] = ((k or 'updated').strip() or 'updated').lower()
    if not merged:
        return
    pending = list(sess.semantic_index_pending)
    for path, kind in merged.items():
        pending.append((path, kind))
    sess.semantic_index_pending = pending[-3000:]


def _staging_abs_allowed(session_id: str, graph_id: str, abs_path: Path) -> bool:
    from nemo_backend.edit_staging import get_staging_root

    abs_path = abs_path.resolve()
    staging_root = get_staging_root().resolve()
    try:
        abs_path.relative_to(staging_root)
    except ValueError:
        return False
    for base in staging_session_roots(session_id, graph_id):
        b = base.resolve()
        if not b.is_dir():
            continue
        try:
            abs_path.relative_to(b)
            return True
        except ValueError:
            continue
    return False


def _parse_workspace_relative(raw: str, workspace_root: Path) -> str | None:
    rel = raw.strip().replace('\\', '/').lstrip('/')
    if rel.lower().startswith('[staging]'):
        return None
    root = workspace_root.resolve()
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate.relative_to(root).as_posix()


def _parse_staging_relative(raw: str) -> str | None:
    s = raw.strip()
    low = s.lower()
    if low.startswith('[staging]'):
        s = s.split(']', 1)[-1].strip().replace('\\', '/').lstrip('/')
    elif s.startswith(_STAGING_PREFIX):
        s = s[len(_STAGING_PREFIX) :].strip().replace('\\', '/').lstrip('/')
    else:
        return None
    if not s or s.startswith('../'):
        return None
    return s


def _replace_ref_nodes(index: Any, doc_id: str, nodes: list[Any]) -> None:
    try:
        index.delete_ref_doc(doc_id, delete_from_docstore=True)
    except Exception as exc:
        logger.warning('semantic index delete_ref_doc failed doc_id=%s: %s', doc_id, exc)
    if nodes:
        index.insert_nodes(nodes)


def flush_semantic_index_patches(
    session_id: str,
    sess: SessionState,
    workspace_root: Path,
    workspace_id: str,
    embed_model: Any,
    *,
    embedding_model_id: str | None = None,
) -> None:
    """Apply queued watcher updates to persisted workspace + staging indexes."""
    batch = list(sess.semantic_index_pending)
    if not batch:
        return
    sess.semantic_index_pending.clear()
    mid = manifest_embedding_model_id(embedding_model_id)
    try:
        _flush_semantic_index_patches_impl(
            session_id,
            sess,
            workspace_root,
            workspace_id,
            embed_model,
            mid,
            batch,
        )
    except Exception:
        sess.semantic_index_pending = batch + sess.semantic_index_pending
        raise


def _flush_semantic_index_patches_impl(
    session_id: str,
    sess: SessionState,
    workspace_root: Path,
    workspace_id: str,
    embed_model: Any,
    manifest_embedding_model: str,
    batch: list[tuple[str, str]],
) -> None:
    from nemo_backend.edit_staging import get_staging_root

    sid = (session_id or '').strip()
    graph_id = (sess.active_staging_snapshot_id or '').strip()
    root = workspace_root.resolve()
    staging_root = get_staging_root().resolve()

    w_lock = _lock_for(_workspace_locks, _workspace_lock_key(workspace_id, root))
    s_lock = _lock_for(_staging_locks, _staging_lock_key(sid)) if sid else None

    workspace_by_rel: dict[str, str] = {}
    staging_hits: list[tuple[str, str]] = []
    for raw, kind in batch:
        if _parse_staging_relative(raw) is not None:
            staging_hits.append((raw, kind))
            continue
        wr = _parse_workspace_relative(raw, root)
        if wr is not None:
            workspace_by_rel[wr] = kind
    workspace_hits = list(workspace_by_rel.items())

    if workspace_hits:
        with w_lock:
            w_index, w_err = load_or_rebuild_workspace_index(
                root,
                workspace_id,
                embed_model,
                fingerprint_override=None,
                embedding_model_id=manifest_embedding_model,
            )
            if w_err or w_index is None:
                logger.debug('skip workspace incremental: %s', w_err or 'no index')
            else:
                for rel, kind in workspace_hits:
                    doc_id = f'{DOC_REF_WORKSPACE}{rel}'
                    abs_path = root / rel
                    if kind == 'deleted' or not abs_path.is_file():
                        _replace_ref_nodes(w_index, doc_id, [])
                        continue
                    if not is_indexable_workspace_relative_path(root, rel):
                        _replace_ref_nodes(w_index, doc_id, [])
                        continue
                    nodes = nodes_from_file_for_workspace(abs_path, root)
                    _replace_ref_nodes(w_index, doc_id, nodes)
                pdir = workspace_index_persist_dir(workspace_id, root)
                try:
                    w_index.storage_context.persist(persist_dir=str(pdir))
                except Exception as exc:
                    logger.warning('persist workspace index failed: %s', exc)
                fp = workspace_content_fingerprint(root, max_files=NEMO_LLAMA_INDEX_MAX_FILES)
                write_workspace_manifest(
                    pdir,
                    workspace_root=root,
                    workspace_id=workspace_id,
                    workspace_fingerprint=fp,
                    embedding_model=manifest_embedding_model,
                )
                invalidate_fingerprint_cache_for_root(root)
    if staging_hits and sid and s_lock:
        with s_lock:
            s_index, s_err = load_or_rebuild_staging_index(
                sid, graph_id, embed_model, embedding_model_id=manifest_embedding_model
            )
            if s_err:
                logger.debug('skip staging incremental: %s', s_err)
            elif s_index is None:
                logger.debug('skip staging incremental: no persisted staging index yet')
            else:
                for raw, kind in staging_hits:
                    sr = _parse_staging_relative(raw)
                    if sr is None:
                        continue
                    abs_path = (staging_root / sr).resolve()
                    doc_id = f'{DOC_REF_STAGING}{sr}'
                    if kind == 'deleted' or not abs_path.is_file():
                        _replace_ref_nodes(s_index, doc_id, [])
                        continue
                    if not _staging_abs_allowed(sid, graph_id, abs_path):
                        continue
                    nodes = nodes_from_file_for_staging(abs_path, staging_root)
                    _replace_ref_nodes(s_index, doc_id, nodes)
                pdir = staging_index_persist_dir(sid)
                try:
                    s_index.storage_context.persist(persist_dir=str(pdir))
                except Exception as exc:
                    logger.warning('persist staging index failed: %s', exc)
                sfp = staging_content_fingerprint(sid, graph_id, max_files=NEMO_LLAMA_INDEX_MAX_FILES)
                write_staging_manifest(
                    pdir,
                    session_id=sid,
                    graph_id=graph_id,
                    staging_fingerprint=sfp,
                    embedding_model=manifest_embedding_model,
                )
                invalidate_fingerprint_cache_for_staging(sid, graph_id)