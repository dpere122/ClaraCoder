"""Tests for :mod:`clara_coder_backend.workspace_index.fastembed_backend` (no Hub download)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from clara_coder_backend.workspace_index import fastembed_backend as fb


def test_fastembed_cache_dir_uses_override(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(fb, 'CLARA_FASTEMBED_CACHE_DIR', str(tmp_path / 'emb'))
    assert fb.fastembed_cache_dir() == (tmp_path / 'emb').resolve()


def test_fastembed_model_id_defaults_to_nomic(monkeypatch) -> None:
    monkeypatch.setattr(fb, 'CLARA_FASTEMBED_MODEL', '')
    assert fb.fastembed_model_id() == 'nomic-ai/nomic-embed-text-v1.5'


def test_query_embed_uses_fastembed_query_api() -> None:
    engine = MagicMock()
    engine.query_embed.return_value = [[0.1, 0.2]]
    embed = fb.FastEmbedEmbedding(model_name='nomic-ai/nomic-embed-text-v1.5', engine=engine)
    vec = embed._get_query_embedding('hello')
    assert vec == [0.1, 0.2]
    engine.query_embed.assert_called_once()
    engine.embed.assert_not_called()


def test_document_embed_uses_passage_embed_when_present() -> None:
    engine = MagicMock()
    engine.passage_embed.return_value = [[0.3, 0.4]]
    embed = fb.FastEmbedEmbedding(model_name='nomic-ai/nomic-embed-text-v1.5', engine=engine)
    vec = embed._get_text_embedding('fn main')
    assert vec == [0.3, 0.4]
    engine.passage_embed.assert_called_once()


def test_nomic_prefix_when_query_embed_missing() -> None:
    engine = MagicMock(spec=['embed'])
    engine.embed.return_value = [[1.0, 0.0]]
    embed = fb.FastEmbedEmbedding(model_name='nomic-ai/nomic-embed-text-v1.5', engine=engine)
    embed._get_query_embedding('hello')
    args, _kwargs = engine.embed.call_args
    assert args[0] == ['search_query: hello']


def test_build_fastembed_embedding_returns_wrapper(monkeypatch, tmp_path: Path) -> None:
    engine = MagicMock()
    engine.query_embed.return_value = [[0.5]]
    monkeypatch.setattr(fb, 'CLARA_FASTEMBED_CACHE_DIR', str(tmp_path))
    monkeypatch.setattr(fb, 'get_text_embedding_engine', lambda _n, _d: engine)
    fb.reset_fastembed_engine_for_tests()
    emb, err = fb.build_fastembed_embedding()
    assert err == ''
    assert emb is not None
    assert emb.model_name == 'nomic-ai/nomic-embed-text-v1.5'
    assert emb.get_query_embedding('q') == [0.5]


def test_build_fastembed_embedding_import_error(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(fb, 'CLARA_FASTEMBED_CACHE_DIR', str(tmp_path))
    fb.reset_fastembed_engine_for_tests()

    def _boom(_name: str, _cache: Path) -> None:
        raise RuntimeError('fastembed missing')

    monkeypatch.setattr(fb, 'get_text_embedding_engine', _boom)
    emb, err = fb.build_fastembed_embedding()
    assert emb is None
    assert 'fastembed' in err.lower()
    assert fb.get_embed_status() == 'error'


def test_load_text_embedding_pins_cpu_and_disables_onnx_arena(monkeypatch, tmp_path: Path) -> None:
    import sys

    captured: dict[str, object] = {}

    class _FakeTextEmbedding:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    fake_fastembed = type(sys)('fastembed')
    fake_fastembed.TextEmbedding = _FakeTextEmbedding  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, 'fastembed', fake_fastembed)
    monkeypatch.setitem(sys.modules, 'onnxruntime', type(sys)('onnxruntime'))

    engine = fb._load_text_embedding('nomic-ai/nomic-embed-text-v1.5', tmp_path)
    assert isinstance(engine, _FakeTextEmbedding)
    assert captured['providers'] == ['CPUExecutionProvider']
    assert captured['cuda'] is False
    assert captured['enable_cpu_mem_arena'] is False
    assert captured['threads'] == fb._ONNX_INTRA_OP_THREADS
    assert int(captured['threads']) <= 4  # type: ignore[arg-type]


def test_query_embed_passes_small_batch_and_no_parallel() -> None:
    engine = MagicMock()
    engine.query_embed.return_value = [[0.1, 0.2]]
    embed = fb.FastEmbedEmbedding(model_name='nomic-ai/nomic-embed-text-v1.5', engine=engine)
    embed._get_query_embedding('hello')
    kwargs = engine.query_embed.call_args.kwargs
    assert kwargs['batch_size'] == fb._EMBED_INFER_BATCH
    assert kwargs['parallel'] is None


def test_get_text_embedding_engine_reuse_restores_ready(monkeypatch, tmp_path: Path) -> None:
    engine = MagicMock()
    monkeypatch.setattr(fb, '_load_text_embedding', lambda *_a, **_k: engine)
    fb.reset_fastembed_engine_for_tests()
    first = fb.get_text_embedding_engine('nomic-ai/nomic-embed-text-v1.5', tmp_path)
    assert first is engine
    assert fb.get_embed_status() == 'ready'
    fb._set_embed_status('error')
    reused = fb.get_text_embedding_engine('nomic-ai/nomic-embed-text-v1.5', tmp_path)
    assert reused is engine
    assert fb.get_embed_status() == 'ready'
