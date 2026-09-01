"""Tests for LlamaIndex workspace semantic index and tool."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from llama_index.core.base.embeddings.base import BaseEmbedding

from clara_coder_backend.config import CLARA_LLAMA_INDEX_MAX_FILES
from clara_coder_backend.domain import SessionState
from clara_coder_backend.session.state import current_session_id
from clara_coder_backend.workspace_index.fingerprint import workspace_content_fingerprint
from clara_coder_backend.workspace_index.index_build import (
    load_or_rebuild_index,
    load_or_rebuild_workspace_index,
    read_manifest,
)
from clara_coder_backend.workspace_index import lifecycle as lc
from clara_coder_backend.workspace_index.paths import index_persist_dir, workspace_index_persist_dir
from clara_coder_backend.workspace_index.incremental import (
    flush_semantic_index_patches,
    schedule_semantic_index_background,
)
from clara_coder_backend.tools.semantic import (
    retrieve_workspace_checkpoint_semantic,
    retrieve_workspace_semantic,
)
from clara_coder_backend.workspace_index.walk import iter_index_workspace_files


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


def test_iter_index_skips_dot_clara(tmp_path: Path) -> None:
    (tmp_path / '.clara' / 'nested').mkdir(parents=True)
    (tmp_path / '.clara' / 'nested' / 'hidden.txt').write_text('secret', encoding='utf-8')
    (tmp_path / 'visible.txt').write_text('ok', encoding='utf-8')
    rels = {p.relative_to(tmp_path).as_posix() for p in iter_index_workspace_files(tmp_path, max_files=50)}
    assert 'visible.txt' in rels
    assert not any(r.startswith('.clara/') for r in rels)


def test_iter_index_skips_runtime_bundle(tmp_path: Path) -> None:
    bundled = tmp_path / 'runtime-bundle' / 'python' / 'Lib'
    bundled.mkdir(parents=True)
    (bundled / 'inspect.py').write_text('def foo():\n    pass\n', encoding='utf-8')
    (tmp_path / 'app.py').write_text('ok\n', encoding='utf-8')
    rels = {p.relative_to(tmp_path).as_posix() for p in iter_index_workspace_files(tmp_path, max_files=50)}
    assert 'app.py' in rels
    assert not any(r.startswith('runtime-bundle/') for r in rels)


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
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'root'))
    from clara_coder_backend.workspace_index.paths import staging_index_persist_dir

    p = staging_index_persist_dir('my-session-id')
    assert 'sessions' in p.as_posix()
    assert 'staging' in p.as_posix()


def test_internal_persist_dir_not_under_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'internal-idx'))
    ws = tmp_path / 'my-workspace'
    ws.mkdir()
    pdir = workspace_index_persist_dir('workspace-card-1', ws)
    assert pdir.is_dir() is False
    assert 'internal-idx' in str(pdir)
    assert not str(pdir.resolve()).startswith(str(ws.resolve()))


def test_retrieve_workspace_semantic_invocation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.tools import semantic as st

    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'semantic-root'))
    (tmp_path / 'notes.md').write_text('# Project\nUse the frobnitz handler for IO.\n', encoding='utf-8')

    def _fake_build(_connection: object) -> tuple[_FakeEmb, str]:
        return _FakeEmb(), ''

    monkeypatch.setattr(st, 'build_embedding_model', _fake_build)

    sid = 'test-semantic-session'
    sess = SessionState()
    sess.workspace_path = str(tmp_path)
    sess.workspace_id = 'ws-card-test'
    from clara_coder_backend.session import state as st_state
    st_state.sessions[sid] = sess
    token = current_session_id.set(sid)
    try:
        out = retrieve_workspace_semantic.invoke({'query': 'frobnitz IO', 'top_k': 3})
    finally:
        current_session_id.reset(token)
        st_state.sessions.pop(sid, None)

    assert 'notes.md' in out
    assert 'frobnitz' in out.lower() or 'handler' in out.lower()
    assert 'no indexable workspace content' not in out
    assert 'on-disk workspace index only' in out
    assert 'read_workspace_file' in out


def test_retrieve_workspace_checkpoint_semantic_invocation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.tools import semantic as st

    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'semantic-root'))
    (tmp_path / 'notes.md').write_text('# Project\nUse the frobnitz handler for IO.\n', encoding='utf-8')

    def _fake_build(_connection: object) -> tuple[_FakeEmb, str]:
        return _FakeEmb(), ''

    monkeypatch.setattr(st, 'build_embedding_model', _fake_build)

    sid = 'test-semantic-checkpoint-session'
    sess = SessionState()
    sess.workspace_path = str(tmp_path)
    sess.workspace_id = 'ws-card-test'
    from clara_coder_backend.session import state as st_state
    st_state.sessions[sid] = sess
    token = current_session_id.set(sid)
    try:
        out = retrieve_workspace_checkpoint_semantic.invoke({'query': 'frobnitz IO', 'top_k': 3})
    finally:
        current_session_id.reset(token)
        st_state.sessions.pop(sid, None)

    assert 'notes.md' in out
    assert 'on-disk workspace index only' in out
    assert 'read_workspace_file' in out


def test_incremental_workspace_patch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    embed = _FakeEmb()

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


@pytest.fixture
def _clear_fingerprint_cache():
    lc._fingerprint_cache.clear()
    yield
    lc._fingerprint_cache.clear()


def test_flush_invalidates_workspace_fingerprint_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, _clear_fingerprint_cache
) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    embed = _FakeEmb()
    _, err = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert err == ''

    key = f'{root.resolve()}\0{CLARA_LLAMA_INDEX_MAX_FILES}'
    lc._fingerprint_cache[key] = (time.monotonic(), 'stale-fingerprint')

    sess = SessionState()
    sess.semantic_index_pending = [('a.py', 'updated')]
    flush_semantic_index_patches('sess-1', sess, root, 'wid', embed, embedding_model_id='test-emb')

    assert key not in lc._fingerprint_cache


def test_load_or_rebuild_rebuilds_when_embedding_model_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'x.py').write_text('v = 1\n', encoding='utf-8')
    embed = _FakeEmb()
    idx, err = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='embed-a')
    assert err == '' and idx is not None

    fp = workspace_content_fingerprint(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
    idx2, err2 = load_or_rebuild_workspace_index(
        root, 'wid', embed, fingerprint_override=fp, embedding_model_id='embed-b'
    )
    assert err2 == '' and idx2 is not None
    man = read_manifest(workspace_index_persist_dir('wid', root))
    assert man is not None
    assert man.get('embedding_model') == 'embed-b'


def test_flush_requeues_pending_on_workspace_load_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('z = 1\n', encoding='utf-8')
    embed = _FakeEmb()
    _, err = load_or_rebuild_workspace_index(root, 'wid', embed)
    assert err == ''

    sess = SessionState()
    sess.semantic_index_pending = [('a.py', 'updated')]

    def _boom(*_a: object, **_kw: object) -> tuple[None, str]:
        raise OSError('simulated load failure')

    monkeypatch.setattr(
        'clara_coder_backend.workspace_index.incremental.load_or_rebuild_workspace_index',
        _boom,
    )
    with pytest.raises(OSError, match='simulated'):
        flush_semantic_index_patches('sess-1', sess, root, 'wid', embed)
    assert sess.semantic_index_pending == [('a.py', 'updated')]


def test_schedule_semantic_index_background_coalesces_ensure_corpus(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.workspace_index import incremental as inc

    calls: list[tuple[str, bool]] = []

    def _fake_run(session_id: str, *, ensure_corpus: bool) -> None:
        calls.append((session_id, ensure_corpus))

    monkeypatch.setattr(inc, '_BACKGROUND_INDEX_DEBOUNCE_SEC', 0.01)
    monkeypatch.setattr(inc, '_run_semantic_index_background', _fake_run)
    inc._background_index_jobs.clear()
    for t in inc._background_index_timers.values():
        t.cancel()
    inc._background_index_timers.clear()

    schedule_semantic_index_background('sess-a', ensure_corpus=False)
    schedule_semantic_index_background('sess-a', ensure_corpus=True)
    time.sleep(0.05)

    assert calls == [('sess-a', True)]


def test_run_semantic_index_background_builds_corpus(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.workspace_index import incremental as inc
    from clara_coder_backend.session import state as st
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'main.py').write_text('print("hi")\n', encoding='utf-8')

    conn = st.get_active_connection()
    conn.provider = 'openai'
    conn.model = 'gpt-test'
    conn.api_key = 'test-key'

    sess = st.get_session('bg-sess')
    sess.workspace_path = str(root)
    sess.workspace_id = 'wid-bg'

    def _fake_build(_conn: object) -> tuple[_FakeEmb, str]:
        return _FakeEmb(), ''

    monkeypatch.setattr(
        'clara_coder_backend.workspace_index.embeddings_factory.build_embedding_model',
        _fake_build,
    )

    inc._run_semantic_index_background('bg-sess', ensure_corpus=True)

    pdir = workspace_index_persist_dir('wid-bg', root)
    assert (pdir / 'manifest.json').is_file()
