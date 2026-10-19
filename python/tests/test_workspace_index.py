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
from clara_coder_backend.tools.semantic import retrieve_workspace_semantic
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


def test_incremental_patch_loads_existing_index_instead_of_rebuilding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Watcher batches must patch the persisted index, not re-embed the whole workspace."""
    from clara_coder_backend.workspace_index import index_build as ib

    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    embed = _FakeEmb()
    idx, err = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert err == '' and idx is not None

    # The file changed after the index was built -> live fingerprint != manifest fingerprint.
    (root / 'a.py').write_text('alpha = 2\nbeta = 3\n', encoding='utf-8')
    (root / 'b.py').write_text('gamma = 4\n', encoding='utf-8')

    rebuilds: list[Path] = []
    real_build = ib.build_fresh_workspace_index

    def _counting_build(workspace_root: Path, *a: object, **kw: object):
        rebuilds.append(workspace_root)
        return real_build(workspace_root, *a, **kw)  # type: ignore[arg-type]

    monkeypatch.setattr(ib, 'build_fresh_workspace_index', _counting_build)

    sess = SessionState()
    sess.semantic_index_pending = [('a.py', 'updated'), ('b.py', 'created')]
    flush_semantic_index_patches('sess-1', sess, root, 'wid', embed, embedding_model_id='test-emb')

    assert rebuilds == []
    assert sess.semantic_index_pending == []
    man = read_manifest(workspace_index_persist_dir('wid', root))
    assert man is not None
    assert man.get('workspace_fingerprint') == workspace_content_fingerprint(
        root, max_files=CLARA_LLAMA_INDEX_MAX_FILES
    )

    out, _ = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert out is not None
    docs = out.docstore.docs
    assert any(d.metadata.get('file_path') == 'b.py' for d in docs.values())
    assert rebuilds == []


def test_incremental_patch_builds_fresh_when_no_index_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    embed = _FakeEmb()

    sess = SessionState()
    sess.semantic_index_pending = [('a.py', 'created')]
    flush_semantic_index_patches('sess-1', sess, root, 'wid', embed, embedding_model_id='test-emb')

    pdir = workspace_index_persist_dir('wid', root)
    man = read_manifest(pdir)
    assert man is not None
    assert man.get('embedding_model') == 'test-emb'
    assert sess.semantic_index_pending == []


def test_stale_index_is_reconciled_not_rebuilt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``ensure_corpus`` / semantic-tool path: a changed tree patches only the changed files."""
    from clara_coder_backend.workspace_index import index_build as ib

    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    (root / 'gone.py').write_text('bye = 1\n', encoding='utf-8')
    stable = {f'stable{i}.py' for i in range(8)}
    for name in stable:
        (root / name).write_text(f'# {name}\nx = 1\n', encoding='utf-8')
    embed = _FakeEmb()
    idx, err = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert err == '' and idx is not None
    man = read_manifest(workspace_index_persist_dir('wid', root))
    assert man is not None and set(man['files']) == {'a.py', 'gone.py'} | stable

    # Tree changes while the app is closed / between conversations.
    (root / 'a.py').write_text('alpha = 2\n', encoding='utf-8')
    (root / 'b.py').write_text('beta = 3\n', encoding='utf-8')
    (root / 'gone.py').unlink()

    rebuilds: list[Path] = []
    real_build = ib.build_fresh_workspace_index

    def _counting_build(workspace_root: Path, *a: object, **kw: object):
        rebuilds.append(workspace_root)
        return real_build(workspace_root, *a, **kw)  # type: ignore[arg-type]

    monkeypatch.setattr(ib, 'build_fresh_workspace_index', _counting_build)

    # Live fingerprint (override=None) no longer matches the manifest -> reconcile.
    out, err2 = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert err2 == '' and out is not None
    assert rebuilds == []
    paths = {d.metadata.get('file_path') for d in out.docstore.docs.values()}
    assert 'b.py' in paths and 'gone.py' not in paths

    man2 = read_manifest(workspace_index_persist_dir('wid', root))
    assert man2 is not None
    assert man2['workspace_fingerprint'] == workspace_content_fingerprint(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
    assert set(man2['files']) == {'a.py', 'b.py'} | stable

    # Now current: plain load, still no rebuild.
    out2, _ = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert out2 is not None and rebuilds == []


def test_stale_index_rebuilds_when_most_files_changed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.workspace_index import index_build as ib

    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    for i in range(4):
        (root / f'f{i}.py').write_text(f'v{i} = {i}\n', encoding='utf-8')
    embed = _FakeEmb()
    _, err = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert err == ''

    for i in range(4):
        (root / f'f{i}.py').write_text(f'v{i} = {i + 100}\n', encoding='utf-8')

    rebuilds: list[Path] = []
    real_build = ib.build_fresh_workspace_index

    def _counting_build(workspace_root: Path, *a: object, **kw: object):
        rebuilds.append(workspace_root)
        return real_build(workspace_root, *a, **kw)  # type: ignore[arg-type]

    monkeypatch.setattr(ib, 'build_fresh_workspace_index', _counting_build)
    out, err2 = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert err2 == '' and out is not None
    assert len(rebuilds) == 1


def test_previous_manifest_stays_loadable_while_build_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A build in progress must not look like "no index" to a concurrent caller."""
    import threading

    from clara_coder_backend.workspace_index import index_build as ib
    from clara_coder_backend.workspace_index.index_build import persisted_workspace_index_fingerprint

    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    embed = _FakeEmb()
    _, err = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
    assert err == ''
    fp_before = persisted_workspace_index_fingerprint(root, 'wid', embedding_model_id='test-emb')
    assert fp_before is not None

    entered = threading.Event()
    release = threading.Event()
    real_batches = ib._iter_workspace_node_batches

    def _slow_batches(workspace_root: Path):
        entered.set()
        assert release.wait(5)
        yield from real_batches(workspace_root)

    monkeypatch.setattr(ib, '_iter_workspace_node_batches', _slow_batches)
    (root / 'a.py').write_text('alpha = 2\n', encoding='utf-8')

    seen: dict[str, str | None] = {}
    t = threading.Thread(
        target=lambda: seen.update(
            done=ib.build_fresh_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')[1]
        )
    )
    t.start()
    assert entered.wait(5)
    # Mid-build: old manifest still on disk and loadable.
    assert persisted_workspace_index_fingerprint(root, 'wid', embedding_model_id='test-emb') == fp_before
    release.set()
    t.join(10)
    assert seen.get('done') == ''
    fp_after = persisted_workspace_index_fingerprint(root, 'wid', embedding_model_id='test-emb')
    assert fp_after is not None and fp_after != fp_before
    pdir = workspace_index_persist_dir('wid', root)
    assert not [p for p in pdir.parent.iterdir() if p.name.startswith(f'{pdir.name}.tmp-')]


def test_concurrent_callers_build_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Background job + watcher flush + semantic tool racing on one workspace -> one build."""
    import threading

    from clara_coder_backend.workspace_index import index_build as ib

    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    embed = _FakeEmb()

    builds = 0
    builds_lock = threading.Lock()
    real_batches = ib._iter_workspace_node_batches

    def _counting_batches(workspace_root: Path):
        nonlocal builds
        with builds_lock:
            builds += 1
        time.sleep(0.2)
        yield from real_batches(workspace_root)

    monkeypatch.setattr(ib, '_iter_workspace_node_batches', _counting_batches)

    errors: list[str] = []

    def _bg() -> None:
        _, e = load_or_rebuild_workspace_index(root, 'wid', embed, embedding_model_id='test-emb')
        errors.append(e)

    def _flush() -> None:
        sess = SessionState()
        sess.semantic_index_pending = [('a.py', 'updated')]
        flush_semantic_index_patches('s', sess, root, 'wid', embed, embedding_model_id='test-emb')

    threads = [threading.Thread(target=_bg), threading.Thread(target=_flush), threading.Thread(target=_bg)]
    for th in threads:
        th.start()
    for th in threads:
        th.join(15)

    assert all(e == '' for e in errors)
    assert builds == 1


def test_persisted_workspace_index_fingerprint_requires_compatible_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from clara_coder_backend.workspace_index.index_build import persisted_workspace_index_fingerprint

    monkeypatch.setenv('CLARA_WORKSPACE_INDEX_DIR', str(tmp_path / 'idx'))
    root = tmp_path / 'proj'
    root.mkdir()
    (root / 'a.py').write_text('alpha = 1\n', encoding='utf-8')
    assert persisted_workspace_index_fingerprint(root, 'wid', embedding_model_id='emb-a') is None

    _, err = load_or_rebuild_workspace_index(root, 'wid', _FakeEmb(), embedding_model_id='emb-a')
    assert err == ''
    fp = workspace_content_fingerprint(root, max_files=CLARA_LLAMA_INDEX_MAX_FILES)
    assert persisted_workspace_index_fingerprint(root, 'wid', embedding_model_id='emb-a') == fp
    # Different embedding model -> not loadable, caller must rebuild.
    assert persisted_workspace_index_fingerprint(root, 'wid', embedding_model_id='emb-b') is None
    # Fingerprint is returned even when the tree has since changed (that is the point).
    (root / 'a.py').write_text('alpha = 2\n', encoding='utf-8')
    assert persisted_workspace_index_fingerprint(root, 'wid', embedding_model_id='emb-a') == fp


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
