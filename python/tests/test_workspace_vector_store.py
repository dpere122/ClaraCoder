"""Float32 numpy vector store, legacy JSON migration, batched builds, and the loaded-index LRU."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from llama_index.core import StorageContext, VectorStoreIndex
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.schema import NodeRelationship, RelatedNodeInfo, TextNode
from llama_index.core.vector_stores.types import VectorStoreQuery

from clara_coder_backend.config import CLARA_LLAMA_INDEX_MAX_FILES
from clara_coder_backend.workspace_index import index_build as ib
from clara_coder_backend.workspace_index.index_build import (
    load_or_rebuild_workspace_index,
    write_workspace_manifest,
)
from clara_coder_backend.workspace_index.fingerprint import fingerprint_for_entries, workspace_file_entries
from clara_coder_backend.workspace_index.lifecycle import invalidate_workspace_index_disk
from clara_coder_backend.workspace_index.paths import workspace_index_persist_dir
from clara_coder_backend.workspace_index.vector_store import NumpyVectorStore, persist_path_for


class _KeywordEmb(BaseEmbedding):
    """Deterministic 3-dim embeddings: one axis per keyword so retrieval order is predictable."""

    @staticmethod
    def _vec(text: str) -> list[float]:
        t = text.lower()
        return [1.0 + t.count('alpha'), 0.1 + t.count('beta'), 0.1 + t.count('gamma')]

    def _get_query_embedding(self, query: str) -> list[float]:
        return self._vec(query)

    def _get_text_embedding(self, text: str) -> list[float]:
        return self._vec(text)

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return self._vec(query)

    async def _aget_text_embedding(self, text: str) -> list[float]:
        return self._vec(text)


def _node(node_id: str, ref: str, emb: list[float]) -> TextNode:
    node = TextNode(id_=node_id, text=node_id, embedding=emb)
    node.relationships[NodeRelationship.SOURCE] = RelatedNodeInfo(node_id=ref)
    return node


def _query(store: NumpyVectorStore, emb: list[float], k: int, node_ids: list[str] | None = None):
    return store.query(VectorStoreQuery(query_embedding=emb, similarity_top_k=k, node_ids=node_ids))


def test_query_ranks_by_cosine_similarity() -> None:
    store = NumpyVectorStore()
    store.add(
        [
            _node('x', 'doc1', [10.0, 0.0, 0.0]),
            _node('y', 'doc1', [0.0, 1.0, 0.0]),
            _node('xy', 'doc2', [1.0, 1.0, 0.0]),
        ]
    )
    res = _query(store, [1.0, 0.0, 0.0], 2)
    assert res.ids == ['x', 'xy']
    assert res.similarities[0] == pytest.approx(1.0)
    assert res.similarities[1] == pytest.approx(1 / np.sqrt(2), rel=1e-5)
    assert _query(store, [1.0, 0.0, 0.0], 10, node_ids=['y']).ids == ['y']


def test_delete_by_ref_doc_compacts_and_keeps_others() -> None:
    store = NumpyVectorStore()
    store.add([_node(f'a{i}', 'doc_a', [1.0, float(i), 0.0]) for i in range(5)])
    store.add([_node('b0', 'doc_b', [0.0, 0.0, 1.0])])
    store.delete('doc_a')
    assert store.count() == 1
    assert _query(store, [1.0, 0.0, 0.0], 10).ids == ['b0']
    store.add([_node('a9', 'doc_a', [1.0, 0.0, 0.0])])
    assert _query(store, [1.0, 0.0, 0.0], 1).ids == ['a9']
    store.delete_nodes(['b0'])
    assert _query(store, [0.0, 0.0, 1.0], 10).ids == ['a9']


def test_readding_a_node_id_replaces_it() -> None:
    store = NumpyVectorStore()
    store.add([_node('n', 'doc', [1.0, 0.0, 0.0])])
    store.add([_node('n', 'doc', [0.0, 1.0, 0.0])])
    assert store.count() == 1
    res = _query(store, [0.0, 1.0, 0.0], 5)
    assert res.ids == ['n'] and res.similarities[0] == pytest.approx(1.0)


def test_persist_roundtrip_is_float32_npy(tmp_path: Path) -> None:
    store = NumpyVectorStore()
    store.add([_node(f'n{i}', f'doc{i % 3}', [float(i), 1.0, 2.0]) for i in range(300)])
    store.delete('doc0')
    path = persist_path_for(tmp_path)
    store.persist(str(path))

    meta = json.loads(path.read_text(encoding='utf-8'))
    assert meta['format'] == 'clara-numpy-v1' and meta['count'] == 200
    mat = np.load(path.with_suffix('.npy'))
    assert mat.dtype == np.float32 and mat.shape == (200, 3)

    loaded = NumpyVectorStore.from_persist_dir(tmp_path)
    q = [5.0, 1.0, 2.0]
    assert _query(loaded, q, 7).ids == _query(store, q, 7).ids
    loaded.delete('doc1')
    assert loaded.count() == 100


def test_inconsistent_store_raises(tmp_path: Path) -> None:
    store = NumpyVectorStore()
    store.add([_node('n', 'doc', [1.0, 0.0])])
    path = persist_path_for(tmp_path)
    store.persist(str(path))
    np.save(path.with_suffix('.npy'), np.zeros((3, 2), dtype=np.float32))
    with pytest.raises(ValueError):
        NumpyVectorStore.from_persist_dir(tmp_path)


def _write_legacy_index(root: Path, wid: str, model: str) -> Path:
    """Persist an index the way the app did before NumpyVectorStore (SimpleVectorStore JSON)."""
    pdir = workspace_index_persist_dir(wid, root)
    nodes = [n for batch in ib._iter_workspace_node_batches(root) for n in batch]
    index = VectorStoreIndex(nodes, storage_context=StorageContext.from_defaults(), embed_model=_KeywordEmb())
    index.storage_context.persist(persist_dir=str(pdir))
    entries = workspace_file_entries(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
    write_workspace_manifest(
        pdir,
        workspace_root=root,
        workspace_id=wid,
        workspace_fingerprint=fingerprint_for_entries(entries),
        embedding_model=model,
        files=entries,
    )
    return pdir


def test_legacy_json_index_is_migrated_without_rebuild(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha alpha alpha\n', encoding='utf-8')
    (root / 'b.py').write_text('beta beta beta\n', encoding='utf-8')
    pdir = _write_legacy_index(root, 'wid', 'test-emb')
    assert 'embedding_dict' in json.loads(persist_path_for(pdir).read_text(encoding='utf-8'))

    rebuilds: list[int] = []
    monkeypatch.setattr(ib, '_iter_workspace_node_batches', lambda r: rebuilds.append(1) or iter(()))
    index, err = load_or_rebuild_workspace_index(root, 'wid', _KeywordEmb(), embedding_model_id='test-emb')
    assert err == '' and index is not None and not rebuilds

    assert json.loads(persist_path_for(pdir).read_text(encoding='utf-8'))['format'] == 'clara-numpy-v1'
    assert persist_path_for(pdir).with_suffix('.npy').is_file()
    assert (pdir / 'docstore.sqlite').is_file() and not (pdir / 'docstore.json').exists()
    hits = index.as_retriever(similarity_top_k=1).retrieve('beta')
    assert hits[0].node.metadata['file_path'] == 'b.py'


def test_full_build_embeds_in_batches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    monkeypatch.setattr(ib, '_BUILD_NODE_BATCH', 2)
    root = tmp_path / 'proj'
    root.mkdir()
    for i in range(7):
        (root / f'f{i}.py').write_text(f'gamma {i}\n' if i != 4 else 'alpha alpha\n', encoding='utf-8')

    batch_sizes: list[int] = []
    real_insert = VectorStoreIndex.insert_nodes

    def _spy_insert(self, nodes, **kw):
        batch_sizes.append(len(nodes))
        return real_insert(self, nodes, **kw)

    monkeypatch.setattr(VectorStoreIndex, 'insert_nodes', _spy_insert)
    index, err = ib.build_fresh_workspace_index(root, 'wid', _KeywordEmb(), embedding_model_id='test-emb')
    assert err == '' and index is not None
    assert batch_sizes and max(batch_sizes) <= 3
    vs = index.storage_context.vector_store
    assert isinstance(vs, NumpyVectorStore) and vs.count() == 7
    hits = index.as_retriever(similarity_top_k=1).retrieve('alpha')
    assert hits[0].node.metadata['file_path'] == 'f4.py'


def test_loaded_index_cache_is_bounded_and_dropped_on_invalidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    monkeypatch.setattr(ib, '_LOADED_INDEXES', type(ib._LOADED_INDEXES)())
    roots = []
    for name in ('one', 'two', 'three'):
        root = tmp_path / name
        root.mkdir()
        (root / 'a.py').write_text(f'{name} alpha\n', encoding='utf-8')
        roots.append(root)
        _, err = load_or_rebuild_workspace_index(root, name, _KeywordEmb(), embedding_model_id='test-emb')
        assert err == ''

    cached = list(ib._LOADED_INDEXES)
    assert len(cached) == ib._LOADED_INDEXES_MAX
    assert str(workspace_index_persist_dir('one', roots[0])) not in cached

    pdir_three = workspace_index_persist_dir('three', roots[2])
    assert str(pdir_three) in ib._LOADED_INDEXES
    invalidate_workspace_index_disk('three', roots[2])
    assert str(pdir_three) not in ib._LOADED_INDEXES


def test_cached_index_reused_across_calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha\n', encoding='utf-8')
    first, _ = load_or_rebuild_workspace_index(root, 'wid', _KeywordEmb(), embedding_model_id='test-emb')
    second, _ = load_or_rebuild_workspace_index(root, 'wid', _KeywordEmb(), embedding_model_id='test-emb')
    assert first is second


def test_sqlite_docstore_commits_on_persist_and_rolls_back_on_close(tmp_path: Path) -> None:
    from clara_coder_backend.workspace_index.docstore import close_docstore, create_docstore, open_docstore

    store = create_docstore(tmp_path)
    store.add_documents([TextNode(id_='kept', text='kept text')])
    store.persist(str(tmp_path / 'docstore.json'))
    store.add_documents([TextNode(id_='dropped', text='never persisted')])
    close_docstore(store)

    reopened = open_docstore(tmp_path)
    assert reopened.get_node('kept').get_content() == 'kept text'
    assert reopened.get_node('dropped', raise_error=False) is None
    with pytest.raises(ValueError):
        reopened.persist(str(tmp_path / 'elsewhere' / 'docstore.json'))
    close_docstore(reopened)


def test_index_dir_can_be_removed_while_an_index_is_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows refuses to delete an open SQLite file; invalidation must close handles first."""
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha\n', encoding='utf-8')
    index, _ = load_or_rebuild_workspace_index(root, 'wid', _KeywordEmb(), embedding_model_id='test-emb')
    assert index is not None
    pdir = workspace_index_persist_dir('wid', root)
    invalidate_workspace_index_disk('wid', root)
    assert not pdir.exists()
    # A full rebuild over an existing (open) index swaps cleanly too.
    load_or_rebuild_workspace_index(root, 'wid', _KeywordEmb(), embedding_model_id='test-emb')
    held, _ = load_or_rebuild_workspace_index(root, 'wid', _KeywordEmb(), embedding_model_id='test-emb')
    rebuilt, err = ib.build_fresh_workspace_index(root, 'wid', _KeywordEmb(), embedding_model_id='test-emb')
    assert err == '' and rebuilt is not None and held is not None
    assert rebuilt.as_retriever(similarity_top_k=1).retrieve('alpha')[0].node.metadata['file_path'] == 'a.py'
