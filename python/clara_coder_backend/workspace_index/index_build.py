"""Build and persist :class:`~llama_index.core.indices.vector_store.VectorStoreIndex` for the workspace."""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from llama_index.core import Document, StorageContext, VectorStoreIndex, load_index_from_storage
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.node_parser import SentenceSplitter

from clara_coder_backend.config import CLARA_EMBEDDINGS_MODEL, CLARA_LLAMA_INDEX_MAX_FILE_BYTES, CLARA_LLAMA_INDEX_MAX_FILES
from clara_coder_backend.workspace_index.fingerprint import (
    fingerprint_for_entries,
    workspace_content_fingerprint,
    workspace_file_entries,
)
from clara_coder_backend.workspace_index.index_read import read_file_for_index
from clara_coder_backend.workspace_index.lifecycle import invalidate_fingerprint_cache_for_root
from clara_coder_backend.workspace_index.paths import workspace_index_persist_dir
from clara_coder_backend.workspace_index.walk import iter_index_workspace_files

logger = logging.getLogger('clara.workspace_index.build')

MANIFEST_NAME = 'manifest.json'
INDEX_VERSION = 2

DOC_REF_WORKSPACE = 'w:'

# In-progress builds write here, then swap into the real persist dir (see
# :func:`build_fresh_workspace_index`). Keeps the previous manifest loadable so a
# concurrent caller never mistakes "build in progress" for "no index".
_BUILD_TMP_INFIX = '.tmp-'

# A stale index whose changed-file share is above this is cheaper to rebuild than to
# patch one file at a time.
_RECONCILE_MAX_CHANGED_FRACTION = 0.5

# One re-entrant lock per persist dir. Every path that may build/load/patch the
# workspace corpus (watcher flush, ``ensure_corpus`` background job, semantic tool)
# goes through it, so two full builds can never run for the same workspace at once;
# the later caller re-reads the manifest after the first finishes and just loads.
_workspace_index_locks: dict[str, threading.RLock] = {}
_workspace_index_locks_guard = threading.Lock()


def workspace_index_lock(workspace_id: str, workspace_root: Path) -> threading.RLock:
    """Re-entrant lock serializing build/load/patch for one workspace corpus."""
    key = str(workspace_index_persist_dir(workspace_id, workspace_root.resolve()))
    with _workspace_index_locks_guard:
        lock = _workspace_index_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _workspace_index_locks[key] = lock
        return lock

# Source-like extensions: tighter chunks than prose (no tree-sitter; avoids optional ``tree_sitter`` dependency).
_CODE_LIKE_SUFFIXES: frozenset[str] = frozenset(
    {
        '.py',
        '.rs',
        '.go',
        '.java',
        '.kt',
        '.kts',
        '.cs',
        '.cpp',
        '.cc',
        '.cxx',
        '.h',
        '.hpp',
        '.c',
        '.rb',
        '.php',
        '.swift',
        '.scala',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.vue',
        '.svelte',
        '.sql',
        '.sh',
        '.bash',
        '.zsh',
        '.ps1',
        '.html',
        '.htm',
        '.css',
        '.scss',
        '.less',
        '.json',
        '.jsonc',
        '.yaml',
        '.yml',
        '.xml',
        '.toml',
        '.ini',
        '.cfg',
        '.conf',
        '.properties',
        '.editorconfig',
    }
)

# Cap below BGE-small's 512-token context. LlamaIndex counts tiktoken tokens, which
# under-count BERT WordPiece on code, so 384 leaves headroom before silent truncation.
_sentence_splitter = SentenceSplitter(chunk_size=384, chunk_overlap=48)
_code_like_sentence_splitter = SentenceSplitter(chunk_size=384, chunk_overlap=48)


def _splitter_for_path(path: Path) -> SentenceSplitter:
    if path.suffix.lower() in _CODE_LIKE_SUFFIXES:
        return _code_like_sentence_splitter
    return _sentence_splitter


def read_manifest(persist_dir: Path) -> dict[str, Any] | None:
    path = persist_dir / MANIFEST_NAME
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None


def write_workspace_manifest(
    persist_dir: Path,
    *,
    workspace_root: Path,
    workspace_id: str,
    workspace_fingerprint: str,
    embedding_model: str,
    files: dict[str, str] | None = None,
) -> None:
    persist_dir.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        'version': INDEX_VERSION,
        'workspace_id': (workspace_id or '').strip(),
        'workspace_root': str(workspace_root.resolve()),
        'workspace_fingerprint': workspace_fingerprint,
        'embedding_model': embedding_model,
    }
    if files is not None:
        # ``rel -> 'mtime_ns:size'`` so a stale index can be patched instead of rebuilt.
        payload['files'] = files
    (persist_dir / MANIFEST_NAME).write_text(json.dumps(payload, indent=2), encoding='utf-8')


def _manifest_workspace_fingerprint(manifest: dict[str, Any]) -> str | None:
    if 'workspace_fingerprint' in manifest:
        return str(manifest.get('workspace_fingerprint') or '')
    # v1 legacy
    return str(manifest.get('fingerprint') or '') or None


def _manifest_files(manifest: dict[str, Any]) -> dict[str, str] | None:
    raw = manifest.get('files')
    if not isinstance(raw, dict):
        return None
    return {str(k): str(v) for k, v in raw.items()}


def _manifest_compatible(manifest: dict[str, Any] | None, *, root: Path, model: str, pdir: Path) -> bool:
    """True when *manifest* describes a loadable index for this root/model/version."""
    if manifest is None:
        return False
    if int(manifest.get('version', 0) or 0) != INDEX_VERSION:
        return False
    if manifest.get('workspace_root') != str(root):
        return False
    if manifest.get('embedding_model') != model:
        return False
    try:
        return any(pdir.iterdir())
    except OSError:
        return False


def replace_ref_nodes(index: Any, doc_id: str, nodes: list[Any]) -> None:
    """Swap every node of *doc_id* for *nodes* (empty list = remove the document)."""
    try:
        index.delete_ref_doc(doc_id, delete_from_docstore=True)
    except Exception as exc:
        logger.warning('semantic index delete_ref_doc failed doc_id=%s: %s', doc_id, exc)
    if nodes:
        index.insert_nodes(nodes)


def persisted_workspace_index_fingerprint(
    workspace_root: Path,
    workspace_id: str,
    *,
    embedding_model_id: str | None = None,
) -> str | None:
    """Fingerprint recorded by a *loadable* persisted workspace index, else ``None``.

    "Loadable" means the manifest exists and matches this index version, workspace
    root, and embedding model. The recorded fingerprint is intentionally **not**
    compared against the current tree: callers that already know which files
    changed (watcher patches) pass it as ``fingerprint_override`` to
    :func:`load_or_rebuild_workspace_index` so the existing index is loaded and
    patched instead of being rebuilt from scratch.
    """
    root = workspace_root.resolve()
    pdir = workspace_index_persist_dir(workspace_id, root)
    manifest = read_manifest(pdir)
    if not _manifest_compatible(
        manifest, root=root, model=manifest_embedding_model_id(embedding_model_id), pdir=pdir
    ):
        return None
    assert manifest is not None
    fp = _manifest_workspace_fingerprint(manifest)
    return fp if fp else None


def nodes_from_file_for_workspace(path: Path, workspace_root: Path) -> list[Any]:
    root = workspace_root.resolve()
    max_bytes = CLARA_LLAMA_INDEX_MAX_FILE_BYTES
    text = read_file_for_index(path, max_bytes=max_bytes)
    if not text or not text.strip():
        return []
    rel = path.relative_to(root).as_posix()
    doc = Document(
        text=text,
        id_=f'{DOC_REF_WORKSPACE}{rel}',
        metadata={'file_path': rel, 'origin': 'workspace'},
    )
    splitter = _splitter_for_path(path)
    return list(splitter.get_nodes_from_documents([doc]))


def _collect_workspace_nodes(workspace_root: Path) -> list[Any]:
    nodes: list[Any] = []
    max_files = CLARA_LLAMA_INDEX_MAX_FILES
    root = workspace_root.resolve()
    for path in iter_index_workspace_files(root, max_files=max_files):
        nodes.extend(nodes_from_file_for_workspace(path, root))
    return nodes


def manifest_embedding_model_id(embedding_model_id: str | None) -> str:
    """Normalize manifest/rebuild model id (matches :func:`~clara_coder_backend.workspace_index.embeddings_factory.resolve_embedding_model_id`)."""
    return (embedding_model_id or '').strip() or CLARA_EMBEDDINGS_MODEL


def _remove_stale_build_dirs(pdir: Path) -> None:
    """Drop ``<pdir>.tmp-*`` leftovers from builds that crashed mid-way."""
    parent = pdir.parent
    if not parent.is_dir():
        return
    prefix = f'{pdir.name}{_BUILD_TMP_INFIX}'
    try:
        for entry in parent.iterdir():
            if entry.name.startswith(prefix) and entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
    except OSError:
        pass


def _swap_into_place(tmp_dir: Path, pdir: Path) -> None:
    """Replace *pdir* with the fully written *tmp_dir* (rename; old dir removed first)."""
    if pdir.exists():
        shutil.rmtree(pdir, ignore_errors=True)
    pdir.parent.mkdir(parents=True, exist_ok=True)
    os.replace(tmp_dir, pdir)


def build_fresh_workspace_index(
    workspace_root: Path,
    workspace_id: str,
    embed_model: BaseEmbedding,
    *,
    embedding_model_id: str | None = None,
) -> tuple[VectorStoreIndex | None, str]:
    """Re-embed the whole workspace into a temp dir, then swap it into the persist dir.

    The previous index (and its manifest) stays on disk and loadable until the new
    one is complete, so concurrent callers see "stale index" rather than "no index"
    and never start a second full build.
    """
    root = workspace_root.resolve()
    pdir = workspace_index_persist_dir(workspace_id, root)
    with workspace_index_lock(workspace_id, root):
        started = time.monotonic()
        _remove_stale_build_dirs(pdir)

        entries = workspace_file_entries(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
        fp = fingerprint_for_entries(entries)
        nodes = _collect_workspace_nodes(root)
        if not nodes:
            if pdir.exists():
                shutil.rmtree(pdir, ignore_errors=True)
            invalidate_fingerprint_cache_for_root(root)
            return None, ''

        tmp_dir = pdir.with_name(f'{pdir.name}{_BUILD_TMP_INFIX}{uuid.uuid4().hex[:12]}')
        tmp_dir.mkdir(parents=True, exist_ok=True)
        try:
            index = VectorStoreIndex(nodes, embed_model=embed_model, show_progress=False)
            index.storage_context.persist(persist_dir=str(tmp_dir))
            mid = manifest_embedding_model_id(embedding_model_id)
            write_workspace_manifest(
                tmp_dir,
                workspace_root=root,
                workspace_id=workspace_id,
                workspace_fingerprint=fp,
                embedding_model=mid,
                files=entries,
            )
            _swap_into_place(tmp_dir, pdir)
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise
        invalidate_fingerprint_cache_for_root(root)
        logger.info(
            'Workspace semantic index built at %s (%s nodes, %s files) in %.1fs',
            pdir,
            len(nodes),
            len(entries),
            time.monotonic() - started,
        )
        return index, ''


def _reconcile_workspace_index(
    index: VectorStoreIndex,
    root: Path,
    *,
    old_files: dict[str, str],
    new_files: dict[str, str],
) -> int:
    """Patch *index* so it reflects *new_files*; returns the number of documents touched."""
    changed = [rel for rel, stamp in new_files.items() if old_files.get(rel) != stamp]
    removed = [rel for rel in old_files if rel not in new_files]
    for rel in removed:
        replace_ref_nodes(index, f'{DOC_REF_WORKSPACE}{rel}', [])
    for rel in changed:
        abs_path = root / rel
        nodes = nodes_from_file_for_workspace(abs_path, root) if abs_path.is_file() else []
        replace_ref_nodes(index, f'{DOC_REF_WORKSPACE}{rel}', nodes)
    return len(changed) + len(removed)


def _changed_fraction(old_files: dict[str, str], new_files: dict[str, str]) -> float:
    total = max(1, len(old_files), len(new_files))
    touched = sum(1 for rel, stamp in new_files.items() if old_files.get(rel) != stamp)
    touched += sum(1 for rel in old_files if rel not in new_files)
    return touched / total


#: Last loaded index per persist dir, keyed by the manifest file's stat + embedding model. Any build, reconcile
#: or incremental patch rewrites the manifest, which changes the stamp and forces a reload.
_LOADED_INDEXES: dict[str, tuple[tuple[int, int, str], VectorStoreIndex]] = {}


def _manifest_stamp(persist_dir: Path, model: str) -> tuple[int, int, str]:
    try:
        st = (persist_dir / MANIFEST_NAME).stat()
    except OSError:
        return (0, 0, model)
    return (st.st_mtime_ns, st.st_size, model)


def load_or_rebuild_workspace_index(
    workspace_root: Path,
    workspace_id: str,
    embed_model: BaseEmbedding,
    *,
    fingerprint_override: str | None = None,
    embedding_model_id: str | None = None,
) -> tuple[VectorStoreIndex | None, str]:
    """Return the workspace index, doing the least work that yields a current one.

    1. No compatible index on disk (missing, other version/root/model) -> full build.
    2. Manifest fingerprint matches *fingerprint_override* (or the live tree) -> load.
    3. Stale index with a per-file manifest -> load and re-embed only the files whose
       ``mtime/size`` changed (full build only when most of the tree changed).
    4. Stale index without per-file data (pre-``files`` manifest) -> full build.

    All of it runs under the per-workspace lock, so a caller that arrives while a
    build is in progress waits, re-reads the fresh manifest, and simply loads.
    """
    root = workspace_root.resolve()
    pdir = workspace_index_persist_dir(workspace_id, root)
    model = manifest_embedding_model_id(embedding_model_id)

    with workspace_index_lock(workspace_id, root):
        fp = fingerprint_override
        if fp is None:
            fp = workspace_content_fingerprint(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
        manifest = read_manifest(pdir)

        if not _manifest_compatible(manifest, root=root, model=model, pdir=pdir):
            return build_fresh_workspace_index(root, workspace_id, embed_model, embedding_model_id=model)
        assert manifest is not None

        stamp = _manifest_stamp(pdir, model)
        cached = _LOADED_INDEXES.get(str(pdir))
        if cached is not None and cached[0] == stamp and _manifest_workspace_fingerprint(manifest) == fp:
            # Same on-disk index as last query: skip re-deserializing the docstore / vector store JSON.
            return cached[1], ''

        try:
            storage_context = StorageContext.from_defaults(persist_dir=str(pdir))
            index = load_index_from_storage(storage_context, embed_model=embed_model)
        except Exception as exc:
            logger.warning('Failed to load workspace semantic index, rebuilding: %s', exc)
            return build_fresh_workspace_index(root, workspace_id, embed_model, embedding_model_id=model)

        if _manifest_workspace_fingerprint(manifest) == fp:
            _LOADED_INDEXES[str(pdir)] = (stamp, index)
            return index, ''

        old_files = _manifest_files(manifest)
        if old_files is None:
            logger.info('Workspace semantic index at %s predates per-file manifests; rebuilding', pdir)
            return build_fresh_workspace_index(root, workspace_id, embed_model, embedding_model_id=model)

        started = time.monotonic()
        new_files = workspace_file_entries(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
        fraction = _changed_fraction(old_files, new_files)
        if fraction > _RECONCILE_MAX_CHANGED_FRACTION:
            logger.info(
                'Workspace semantic index at %s: %.0f%% of files changed; rebuilding',
                pdir,
                fraction * 100,
            )
            return build_fresh_workspace_index(root, workspace_id, embed_model, embedding_model_id=model)

        touched = _reconcile_workspace_index(index, root, old_files=old_files, new_files=new_files)
        try:
            index.storage_context.persist(persist_dir=str(pdir))
        except Exception as exc:
            logger.warning('persist workspace index after reconcile failed: %s', exc)
        write_workspace_manifest(
            pdir,
            workspace_root=root,
            workspace_id=workspace_id,
            workspace_fingerprint=fingerprint_for_entries(new_files),
            embedding_model=model,
            files=new_files,
        )
        invalidate_fingerprint_cache_for_root(root)
        logger.info(
            'Workspace semantic index reconciled at %s (%s of %s files re-embedded) in %.1fs',
            pdir,
            touched,
            len(new_files),
            time.monotonic() - started,
        )
        return index, ''


# --- Backwards-compatible names for tests / callers ---


def write_manifest(persist_dir: Path, *, workspace_root: Path, fingerprint: str, embedding_model: str) -> None:
    """Legacy manifest writer (v1 layout tests). Prefer :func:`write_workspace_manifest`."""
    persist_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        'version': INDEX_VERSION,
        'workspace_id': '',
        'workspace_root': str(workspace_root.resolve()),
        'workspace_fingerprint': fingerprint,
        'embedding_model': embedding_model,
    }
    (persist_dir / MANIFEST_NAME).write_text(json.dumps(payload, indent=2), encoding='utf-8')


def _collect_nodes(workspace_root: Path) -> list[Any]:
    return _collect_workspace_nodes(workspace_root)


def build_fresh_index(
    workspace_root: Path,
    embed_model: BaseEmbedding,
    *,
    embedding_model_id: str | None = None,
) -> tuple[VectorStoreIndex | None, str]:
    """Build workspace index only (no workspace_id); for tests under legacy path layout."""
    from clara_coder_backend.workspace_index.paths import index_persist_dir as legacy_index_persist_dir

    root = workspace_root.resolve()
    pdir = legacy_index_persist_dir(root)
    if pdir.exists():
        shutil.rmtree(pdir, ignore_errors=True)
    pdir.mkdir(parents=True, exist_ok=True)

    fp = workspace_content_fingerprint(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
    nodes = _collect_workspace_nodes(root)
    if not nodes:
        shutil.rmtree(pdir, ignore_errors=True)
        return None, ''

    index = VectorStoreIndex(nodes, embed_model=embed_model, show_progress=False)
    index.storage_context.persist(persist_dir=str(pdir))
    mid = manifest_embedding_model_id(embedding_model_id)
    write_manifest(pdir, workspace_root=root, fingerprint=fp, embedding_model=mid)
    invalidate_fingerprint_cache_for_root(root)
    logger.info('Workspace semantic index built at %s (%s nodes)', pdir, len(nodes))
    return index, ''


def load_or_rebuild_index(
    workspace_root: Path,
    embed_model: BaseEmbedding,
    *,
    fingerprint_override: str | None = None,
    embedding_model_id: str | None = None,
) -> tuple[VectorStoreIndex | None, str]:
    """Load/rebuild using legacy in-workspace persist dir (tests)."""
    from clara_coder_backend.workspace_index.paths import index_persist_dir as legacy_index_persist_dir

    root = workspace_root.resolve()
    pdir = legacy_index_persist_dir(root)
    fp = fingerprint_override
    if fp is None:
        fp = workspace_content_fingerprint(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
    model = manifest_embedding_model_id(embedding_model_id)
    manifest = read_manifest(pdir)

    def _needs_rebuild() -> bool:
        if manifest is None:
            return True
        if int(manifest.get('version', 0) or 0) != INDEX_VERSION:
            return True
        if manifest.get('workspace_root') != str(root):
            return True
        mf = _manifest_workspace_fingerprint(manifest)
        if mf != fp:
            return True
        if manifest.get('embedding_model') != model:
            return True
        if not any(pdir.iterdir()):
            return True
        return False

    if _needs_rebuild():
        return build_fresh_index(root, embed_model, embedding_model_id=model)

    try:
        storage_context = StorageContext.from_defaults(persist_dir=str(pdir))
        index = load_index_from_storage(storage_context, embed_model=embed_model)
    except Exception as exc:
        logger.warning('Failed to load semantic index, rebuilding: %s', exc)
        return build_fresh_index(root, embed_model, embedding_model_id=model)

    return index, ''
