"""Tests for LlamaIndex workspace semantic index and tool."""

from __future__ import annotations

from pathlib import Path

import pytest
from llama_index.core.base.embeddings.base import BaseEmbedding

from nemo_backend.domain import SessionState
from nemo_backend.state import current_session_id
from nemo_backend.workspace_index.fingerprint import workspace_content_fingerprint
from nemo_backend.workspace_index.index_build import load_or_rebuild_index, read_manifest
from nemo_backend.workspace_index.paths import index_persist_dir, workspace_index_persist_dir
from nemo_backend.workspace_index.semantic_tool import (
    retrieve_workspace_checkpoint_semantic,
    retrieve_workspace_semantic,
)
from nemo_backend.workspace_index.walk import iter_index_workspace_files


class _FakeEmb(BaseEmbedding):
    """Fixed-dimension embeddings so vector index tests need no network."""

    def _get_query_embedding(self, query: str) -> list[float]:
        return [0.01] * 16

    def _get_text_embedding(self, text: str) -> list[float]:
        return [0.02] * 16

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return self._get_query_embedding(query)

    async def _aget_text_embedding(self, text: str) -> list[float]:
        return self._get_text_embedding(text)


def test_iter_index_skips_dot_nemo(tmp_path: Path) -> None:
    (tmp_path / '.nemo' / 'nested').mkdir(parents=True)
    (tmp_path / '.nemo' / 'nested' / 'hidden.txt').write_text('secret', encoding='utf-8')
    (tmp_path / 'visible.txt').write_text('ok', encoding='utf-8')
    rels = {p.relative_to(tmp_path).as_posix() for p in iter_index_workspace_files(tmp_path, max_files=50)}
    assert 'visible.txt' in rels
    assert not any(r.startswith('.nemo/') for r in rels)


def test_pdf_allowed_in_index_walk(tmp_path: Path) -> None:
    (tmp_path / 'a.pdf').write_bytes(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    files = list(iter_index_workspace_files(tmp_path, max_files=20))
    assert any(f.name == 'a.pdf' for f in files)


def test_load_or_rebuild_persist_and_manifest(tmp_path: Path) -> None:
    (tmp_path / 'mod.py').write_text('def answer():\n    return 42\n', encoding='utf-8')
    embed = _FakeEmb()
    idx, err = load_or_rebuild_index(tmp_path, embed)
    assert err == ''
    assert idx is not None
    pdir = index_persist_dir(tmp_path)
    assert pdir.is_dir()
    man = read_manifest(pdir)
    assert man is not None
    assert man.get('embedding_model')
    fp = workspace_content_fingerprint(tmp_path, max_files=8000)
    assert man.get('workspace_fingerprint') == fp

    idx2, err2 = load_or_rebuild_index(tmp_path, embed, fingerprint_override=fp)
    assert err2 == ''
    assert idx2 is not None


def test_staging_index_dir_is_session_scoped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('NEMO_WORKSPACE_INDEX_DIR', str(tmp_path / 'root'))
    from nemo_backend.workspace_index.paths import staging_index_persist_dir

    p = staging_index_persist_dir('my-session-id')
    assert 'sessions' in p.as_posix()
    assert 'staging' in p.as_posix()


def test_internal_persist_dir_not_under_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('NEMO_WORKSPACE_INDEX_DIR', str(tmp_path / 'internal-idx'))
    ws = tmp_path / 'my-workspace'
    ws.mkdir()
    pdir = workspace_index_persist_dir('workspace-card-1', ws)
    assert pdir.is_dir() is False
    assert 'internal-idx' in str(pdir)
    assert not str(pdir.resolve()).startswith(str(ws.resolve()))


def test_retrieve_workspace_semantic_invocation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from nemo_backend.workspace_index import semantic_tool as st

    monkeypatch.setenv('NEMO_WORKSPACE_INDEX_DIR', str(tmp_path / 'semantic-root'))
    (tmp_path / 'notes.md').write_text('# Project\nUse the frobnitz handler for IO.\n', encoding='utf-8')

    def _fake_build(_connection: object) -> tuple[_FakeEmb, str]:
        return _FakeEmb(), ''

    monkeypatch.setattr(st, 'build_embedding_model', _fake_build)

    sid = 'test-semantic-session'
    sess = SessionState()
    sess.workspace_path = str(tmp_path)
    sess.workspace_id = 'ws-card-test'
    from nemo_backend import state as st_state

    st_state.sessions[sid] = sess
    token = current_session_id.set(sid)
    try:
        out = retrieve_workspace_semantic.invoke({'query': 'frobnitz IO', 'top_k': 3})
    finally:
        current_session_id.reset(token)
        st_state.sessions.pop(sid, None)

    assert 'notes.md' in out
    assert 'frobnitz' in out.lower() or 'handler' in out.lower()
    assert 'read_staged_edit' in out
    assert 'diff_staged_edit_against_baseline' in out
    assert 'origin=workspace' in out


def test_retrieve_workspace_checkpoint_semantic_invocation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from nemo_backend.workspace_index import semantic_tool as st

    monkeypatch.setenv('NEMO_WORKSPACE_INDEX_DIR', str(tmp_path / 'semantic-root'))
    (tmp_path / 'notes.md').write_text('# Project\nUse the frobnitz handler for IO.\n', encoding='utf-8')

    def _staging_must_not_load(*_a: object, **_kw: object) -> None:
        raise AssertionError('checkpoint semantic must not load staging index')

    monkeypatch.setattr(st, 'load_or_rebuild_staging_index', _staging_must_not_load)

    def _fake_build(_connection: object) -> tuple[_FakeEmb, str]:
        return _FakeEmb(), ''

    monkeypatch.setattr(st, 'build_embedding_model', _fake_build)

    sid = 'test-semantic-checkpoint-session'
    sess = SessionState()
    sess.workspace_path = str(tmp_path)
    sess.workspace_id = 'ws-card-test'
    from nemo_backend import state as st_state

    st_state.sessions[sid] = sess
    token = current_session_id.set(sid)
    try:
        out = retrieve_workspace_checkpoint_semantic.invoke({'query': 'frobnitz IO', 'top_k': 3})
    finally:
        current_session_id.reset(token)
        st_state.sessions.pop(sid, None)

    assert 'notes.md' in out
    assert 'on-disk workspace / checkpoint index only' in out
    assert 'read_workspace_file' in out


def test_incremental_workspace_patch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('NEMO_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    embed = _FakeEmb()
    from nemo_backend.workspace_index.index_build import load_or_rebuild_workspace_index
    from nemo_backend.workspace_index.incremental import flush_semantic_index_patches

    idx, err = load_or_rebuild_workspace_index(root, 'wid', embed)
    assert err == ''
    assert idx is not None

    sess = SessionState()
    sess.semantic_index_pending = [('a.py', 'updated')]
    flush_semantic_index_patches('sess-1', sess, root, 'wid', embed)

    out, _ = load_or_rebuild_workspace_index(root, 'wid', embed)
    assert out is not None
    hits = out.as_retriever(similarity_top_k=3).retrieve('alpha')
    assert hits
