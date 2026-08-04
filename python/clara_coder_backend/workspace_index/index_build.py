"""Build and persist :class:`~llama_index.core.indices.vector_store.VectorStoreIndex` for the workspace."""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any

from llama_index.core import Document, StorageContext, VectorStoreIndex, load_index_from_storage
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.node_parser import SentenceSplitter

from clara_coder_backend.config import CLARA_EMBEDDINGS_MODEL, CLARA_LLAMA_INDEX_MAX_FILE_BYTES, CLARA_LLAMA_INDEX_MAX_FILES
from clara_coder_backend.workspace_index.fingerprint import workspace_content_fingerprint
from clara_coder_backend.workspace_index.index_read import read_file_for_index
from clara_coder_backend.workspace_index.lifecycle import invalidate_fingerprint_cache_for_root
from clara_coder_backend.workspace_index.paths import workspace_index_persist_dir
from clara_coder_backend.workspace_index.walk import iter_index_workspace_files

logger = logging.getLogger('clara.workspace_index.build')

MANIFEST_NAME = 'manifest.json'
INDEX_VERSION = 2

DOC_REF_WORKSPACE = 'w:'

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

_sentence_splitter = SentenceSplitter(chunk_size=1024, chunk_overlap=128)
_code_like_sentence_splitter = SentenceSplitter(chunk_size=512, chunk_overlap=64)


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
) -> None:
    persist_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        'version': INDEX_VERSION,
        'workspace_id': (workspace_id or '').strip(),
        'workspace_root': str(workspace_root.resolve()),
        'workspace_fingerprint': workspace_fingerprint,
        'embedding_model': embedding_model,
    }
    (persist_dir / MANIFEST_NAME).write_text(json.dumps(payload, indent=2), encoding='utf-8')


def _manifest_workspace_fingerprint(manifest: dict[str, Any]) -> str | None:
    if 'workspace_fingerprint' in manifest:
        return str(manifest.get('workspace_fingerprint') or '')
    # v1 legacy
    return str(manifest.get('fingerprint') or '') or None


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


def build_fresh_workspace_index(
    workspace_root: Path,
    workspace_id: str,
    embed_model: BaseEmbedding,
    *,
    embedding_model_id: str | None = None,
) -> tuple[VectorStoreIndex | None, str]:
    root = workspace_root.resolve()
    pdir = workspace_index_persist_dir(workspace_id, root)
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
    write_workspace_manifest(
        pdir,
        workspace_root=root,
        workspace_id=workspace_id,
        workspace_fingerprint=fp,
        embedding_model=mid,
    )
    invalidate_fingerprint_cache_for_root(root)
    logger.info('Workspace semantic index built at %s (%s nodes)', pdir, len(nodes))
    return index, ''


def load_or_rebuild_workspace_index(
    workspace_root: Path,
    workspace_id: str,
    embed_model: BaseEmbedding,
    *,
    fingerprint_override: str | None = None,
    embedding_model_id: str | None = None,
) -> tuple[VectorStoreIndex | None, str]:
    root = workspace_root.resolve()
    pdir = workspace_index_persist_dir(workspace_id, root)
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
        return build_fresh_workspace_index(root, workspace_id, embed_model, embedding_model_id=model)

    try:
        storage_context = StorageContext.from_defaults(persist_dir=str(pdir))
        index = load_index_from_storage(storage_context, embed_model=embed_model)
    except Exception as exc:
        logger.warning('Failed to load workspace semantic index, rebuilding: %s', exc)
        return build_fresh_workspace_index(root, workspace_id, embed_model, embedding_model_id=model)

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
