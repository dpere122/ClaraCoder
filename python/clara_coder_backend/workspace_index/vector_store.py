"""Float32 numpy vector store for the workspace semantic index.

LlamaIndex's ``SimpleVectorStore`` keeps every embedding as a list of Python floats
(~9x the size of float32) and persists them as JSON. A 5.7k-chunk workspace cost
~77 MB resident (128 MB peak while loading) for 8.7 MB of float32 data. This store
keeps one row-normalized float32 matrix, persists it as ``.npy``, and answers cosine
top-k with a single matrix-vector product.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from llama_index.core.bridge.pydantic import PrivateAttr
from llama_index.core.schema import BaseNode
from llama_index.core.vector_stores.types import (
    BasePydanticVectorStore,
    MetadataFilters,
    VectorStoreQuery,
    VectorStoreQueryMode,
    VectorStoreQueryResult,
)

logger = logging.getLogger('clara.workspace_index.vector_store')

STORE_FORMAT = 'clara-numpy-v1'
DEFAULT_NAMESPACE = 'default'

_MIN_CAPACITY = 256
# Deleted rows are tombstoned; compact once they exceed this share of the matrix.
_COMPACT_DEAD_FRACTION = 0.25


def persist_path_for(persist_dir: str | Path, namespace: str = DEFAULT_NAMESPACE) -> Path:
    """Metadata JSON path, matching LlamaIndex's ``StorageContext.persist`` naming."""
    return Path(persist_dir) / f'{namespace}__vector_store.json'


def _matrix_path(persist_path: str | Path) -> Path:
    return Path(persist_path).with_suffix('.npy')


def _normalize_rows(mat: np.ndarray) -> None:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    np.divide(mat, norms, out=mat, where=norms > 0)


def _write_atomic(path: Path, write: Any) -> None:
    tmp = path.with_name(f'{path.name}.tmp')
    with open(tmp, 'wb') as f:
        write(f)
    os.replace(tmp, path)


class NumpyVectorStore(BasePydanticVectorStore):
    """In-memory float32 vector store; text lives in the index docstore (``stores_text=False``)."""

    stores_text: bool = False

    _lock: threading.RLock = PrivateAttr(default_factory=threading.RLock)
    _vecs: Any = PrivateAttr(default=None)  # (capacity, dim) float32, rows unit-length
    _alive: Any = PrivateAttr(default=None)  # (capacity,) bool
    _ids: list[str | None] = PrivateAttr(default_factory=list)
    _refs: list[str | None] = PrivateAttr(default_factory=list)
    _row_by_id: dict[str, int] = PrivateAttr(default_factory=dict)
    _rows_by_ref: dict[str, list[int]] = PrivateAttr(default_factory=dict)
    _dead: int = PrivateAttr(default=0)

    @classmethod
    def class_name(cls) -> str:
        return 'NumpyVectorStore'

    @property
    def client(self) -> None:
        return None

    def count(self) -> int:
        """Live vectors. (Not ``__len__``: LlamaIndex tests ``if vector_store:``, so an empty store must stay truthy.)"""
        with self._lock:
            return len(self._ids) - self._dead

    # --- mutation ---

    def add(self, nodes: Sequence[BaseNode], **add_kwargs: Any) -> list[str]:
        if not nodes:
            return []
        batch = np.asarray([node.get_embedding() for node in nodes], dtype=np.float32)
        if batch.ndim != 2:
            raise ValueError(f'expected a 2-D embedding batch, got shape {batch.shape}')
        _normalize_rows(batch)
        with self._lock:
            self._ensure_capacity(len(nodes), batch.shape[1])
            start = len(self._ids)
            self._vecs[start : start + len(nodes)] = batch
            self._alive[start : start + len(nodes)] = True
            for offset, node in enumerate(nodes):
                row = start + offset
                node_id = node.node_id
                ref = node.ref_doc_id or 'None'
                old = self._row_by_id.get(node_id)
                if old is not None:
                    self._kill(old)
                self._ids.append(node_id)
                self._refs.append(ref)
                self._row_by_id[node_id] = row
                self._rows_by_ref.setdefault(ref, []).append(row)
            self._maybe_compact()
        return [node.node_id for node in nodes]

    def delete(self, ref_doc_id: str, **delete_kwargs: Any) -> None:
        with self._lock:
            for row in self._rows_by_ref.pop(ref_doc_id, []):
                self._kill(row)
            self._maybe_compact()

    def delete_nodes(
        self,
        node_ids: list[str] | None = None,
        filters: MetadataFilters | None = None,
        **delete_kwargs: Any,
    ) -> None:
        if filters is not None:
            raise NotImplementedError('NumpyVectorStore does not support metadata filters')
        with self._lock:
            for node_id in node_ids or []:
                row = self._row_by_id.get(node_id)
                if row is not None:
                    self._kill(row)
            self._maybe_compact()

    def clear(self) -> None:
        with self._lock:
            self._vecs = None
            self._alive = None
            self._ids = []
            self._refs = []
            self._row_by_id = {}
            self._rows_by_ref = {}
            self._dead = 0

    def _ensure_capacity(self, extra: int, dim: int) -> None:
        if self._vecs is None:
            cap = max(_MIN_CAPACITY, extra)
            self._vecs = np.zeros((cap, dim), dtype=np.float32)
            self._alive = np.zeros(cap, dtype=bool)
            return
        if dim != self._vecs.shape[1]:
            raise ValueError(f'embedding dim {dim} does not match store dim {self._vecs.shape[1]}')
        need = len(self._ids) + extra
        cap = self._vecs.shape[0]
        if need <= cap:
            return
        new_cap = max(need, cap * 2, _MIN_CAPACITY)
        vecs = np.zeros((new_cap, dim), dtype=np.float32)
        vecs[:cap] = self._vecs
        alive = np.zeros(new_cap, dtype=bool)
        alive[:cap] = self._alive
        self._vecs, self._alive = vecs, alive

    def _kill(self, row: int) -> None:
        node_id = self._ids[row]
        if node_id is None:
            return
        self._row_by_id.pop(node_id, None)
        ref = self._refs[row]
        rows = self._rows_by_ref.get(ref) if ref is not None else None
        if rows is not None:
            rows.remove(row)
            if not rows:
                self._rows_by_ref.pop(ref, None)
        self._ids[row] = None
        self._refs[row] = None
        self._alive[row] = False
        self._dead += 1

    def _maybe_compact(self) -> None:
        if self._dead and self._dead > _COMPACT_DEAD_FRACTION * len(self._ids):
            self._compact()

    def _compact(self) -> None:
        """Drop tombstoned rows and trim spare capacity."""
        n = len(self._ids)
        if self._vecs is None:
            return
        keep = np.flatnonzero(self._alive[:n])
        self._vecs = np.ascontiguousarray(self._vecs[keep])
        self._alive = np.ones(len(keep), dtype=bool)
        self._ids = [self._ids[i] for i in keep]
        self._refs = [self._refs[i] for i in keep]
        self._reindex()
        self._dead = 0

    def _reindex(self) -> None:
        self._row_by_id = {}
        self._rows_by_ref = {}
        for row, (node_id, ref) in enumerate(zip(self._ids, self._refs)):
            if node_id is None:
                continue
            self._row_by_id[node_id] = row
            self._rows_by_ref.setdefault(ref or 'None', []).append(row)

    # --- query ---

    def query(self, query: VectorStoreQuery, **kwargs: Any) -> VectorStoreQueryResult:
        if query.mode != VectorStoreQueryMode.DEFAULT:
            raise ValueError(f'NumpyVectorStore supports only the default query mode, not {query.mode}')
        if query.filters is not None:
            raise ValueError('NumpyVectorStore does not support metadata filters')
        if query.query_embedding is None:
            raise ValueError('query_embedding is required')
        q = np.asarray(query.query_embedding, dtype=np.float32)
        q_norm = float(np.linalg.norm(q))
        if q_norm > 0:
            q = q / q_norm

        with self._lock:
            n = len(self._ids)
            if self._vecs is None or n == self._dead or query.similarity_top_k <= 0:
                return VectorStoreQueryResult(similarities=[], ids=[])
            sims = self._vecs[:n] @ q
            mask: np.ndarray | None = self._alive[:n].copy() if self._dead else None
            if query.node_ids is not None:
                allowed = np.zeros(n, dtype=bool)
                rows = [self._row_by_id[i] for i in query.node_ids if i in self._row_by_id]
                allowed[rows] = True
                mask = allowed if mask is None else mask & allowed
            valid = n
            if mask is not None:
                sims = np.where(mask, sims, -np.inf)
                valid = int(mask.sum())
            k = min(query.similarity_top_k, valid)
            if k <= 0:
                return VectorStoreQueryResult(similarities=[], ids=[])
            top = np.argpartition(-sims, k - 1)[:k]
            top = top[np.argsort(-sims[top], kind='stable')]
            return VectorStoreQueryResult(
                similarities=[float(sims[i]) for i in top],
                ids=[self._ids[i] for i in top],
            )

    # --- persistence ---

    def persist(self, persist_path: str, fs: Any = None) -> None:
        """Write ``<name>.npy`` (matrix) then ``<name>.json`` (ids); the JSON is the commit point."""
        path = Path(persist_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            if self._dead:
                self._compact()
            n = len(self._ids)
            if self._vecs is None:
                mat = np.zeros((0, 0), dtype=np.float32)
            else:
                mat = self._vecs[:n]
            meta = {
                'format': STORE_FORMAT,
                'dim': int(mat.shape[1]),
                'count': n,
                'ids': list(self._ids),
                'ref_doc_ids': list(self._refs),
            }
            _write_atomic(_matrix_path(path), lambda f: np.save(f, mat, allow_pickle=False))
            _write_atomic(path, lambda f: f.write(json.dumps(meta).encode('utf-8')))

    @classmethod
    def from_persist_dir(cls, persist_dir: str | Path, namespace: str = DEFAULT_NAMESPACE) -> NumpyVectorStore:
        return cls.from_persist_path(persist_path_for(persist_dir, namespace))

    @classmethod
    def from_persist_path(cls, persist_path: str | Path) -> NumpyVectorStore:
        """Load a persisted store; a legacy ``SimpleVectorStore`` JSON is converted and rewritten in place."""
        path = Path(persist_path)
        with open(path, encoding='utf-8') as f:
            meta = json.load(f)

        if meta.get('format') == STORE_FORMAT:
            ids = list(meta.get('ids') or [])
            refs = list(meta.get('ref_doc_ids') or [])
            mat = np.load(_matrix_path(path), allow_pickle=False)
            if mat.dtype != np.float32:
                mat = mat.astype(np.float32)
            if len(ids) != len(refs) or (ids and (mat.ndim != 2 or mat.shape[0] != len(ids))):
                raise ValueError(f'vector store at {path} is inconsistent (ids={len(ids)} matrix={mat.shape})')
            return cls._from_arrays(ids, refs, mat if ids else None)

        embedding_dict = meta.get('embedding_dict')
        if isinstance(embedding_dict, dict):
            ref_map = meta.get('text_id_to_ref_doc_id') or {}
            ids = list(embedding_dict)
            refs = [str(ref_map.get(i, 'None')) for i in ids]
            mat = np.asarray([embedding_dict[i] for i in ids], dtype=np.float32) if ids else None
            del meta, embedding_dict
            if mat is not None:
                _normalize_rows(mat)
            store = cls._from_arrays(ids, refs, mat)
            store.persist(str(path))
            logger.info('Converted legacy JSON vector store at %s to float32 (%s vectors)', path, len(ids))
            return store

        raise ValueError(f'unrecognized vector store file {path}')

    @classmethod
    def _from_arrays(cls, ids: list[str], refs: list[str], mat: np.ndarray | None) -> NumpyVectorStore:
        store = cls()
        if mat is not None and len(ids):
            store._vecs = np.ascontiguousarray(mat)
            store._alive = np.ones(len(ids), dtype=bool)
            store._ids = list(ids)
            store._refs = list(refs)
            store._reindex()
        return store
