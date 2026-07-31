"""Tests for :mod:`clara_coder_backend.workspace_index.embeddings_factory`."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from clara_coder_backend.session.domain import RuntimeConnection


def _llamacpp_conn(**kwargs: object) -> RuntimeConnection:
    base: dict[str, object] = {
        'id': 'c',
        'name': 'c',
        'provider': 'llamacpp',
        'base_url': 'http://127.0.0.1:8080/v1',
        'model': 'chat-model',
        'api_key': '',
        'reasoning_effort': '',
        'temperature': 0.0,
        'parallel_tool_calls': False,
        'optimization_preset': 'generic',
        'max_output_tokens': 0,
        'plan_retry_attempts_count': 2,
        'embeddings_enabled': True,
    }
    base.update(kwargs)
    return RuntimeConnection(**base)  # type: ignore[arg-type]


def _lmstudio_conn(**kwargs: object) -> RuntimeConnection:
    base: dict[str, object] = {
        'id': 'c',
        'name': 'c',
        'provider': 'lmstudio',
        'base_url': 'http://127.0.0.1:1234/v1',
        'model': 'chat-model',
        'api_key': '',
        'reasoning_effort': '',
        'temperature': 0.0,
        'parallel_tool_calls': False,
        'optimization_preset': 'generic',
        'max_output_tokens': 0,
        'plan_retry_attempts_count': 2,
        'embeddings_enabled': True,
    }
    base.update(kwargs)
    return RuntimeConnection(**base)  # type: ignore[arg-type]


def test_build_embedding_model_skips_llamacpp_when_chat_base_uses_port_zero(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', '')
    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'ChunkPoolingOpenAIEmbedding', _no)

    emb, err = ef.build_embedding_model(
        _llamacpp_conn(base_url='http://127.0.0.1:0/v1', embeddings_model='emb-model'),
    )
    assert emb is None
    assert 'unavailable' in err.lower()
    assert not called


def test_build_embedding_model_skips_llamacpp_when_embeddings_disabled(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', '')
    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'ChunkPoolingOpenAIEmbedding', _no)

    emb, err = ef.build_embedding_model(_llamacpp_conn(embeddings_enabled=False))
    assert emb is None
    assert 'disabled' in err.lower()
    assert not called


@patch('clara_coder_backend.workspace_index.embeddings_factory.ChunkPoolingOpenAIEmbedding')
def test_build_embedding_model_llamacpp_disabled_still_uses_nemo_embeddings_url(mock_ctor: MagicMock, monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', 'http://127.0.0.1:9000')
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_API_KEY', '')

    emb, err = ef.build_embedding_model(_llamacpp_conn(embeddings_enabled=False))
    assert err == ''
    assert emb is mock_inst


@patch('clara_coder_backend.workspace_index.embeddings_factory.ChunkPoolingOpenAIEmbedding')
def test_build_embedding_model_respects_nemo_embeddings_base_url(mock_ctor: MagicMock, monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', 'http://127.0.0.1:9000')
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_API_KEY', '')

    emb, err = ef.build_embedding_model(_llamacpp_conn(embeddings_model='emb-model'))
    assert err == ''
    assert emb is mock_inst
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('api_base') == 'http://127.0.0.1:9000/v1'


@patch('clara_coder_backend.workspace_index.embeddings_factory.ChunkPoolingOpenAIEmbedding')
def test_build_embedding_model_per_connection_embeddings_base_url_over_env(mock_ctor: MagicMock, monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', 'http://127.0.0.1:9000')
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_API_KEY', '')

    conn = _llamacpp_conn(embeddings_base_url='http://127.0.0.1:7777')
    emb, err = ef.build_embedding_model(conn)
    assert err == ''
    assert emb is mock_inst
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('api_base') == 'http://127.0.0.1:7777/v1'


@patch('clara_coder_backend.workspace_index.embeddings_factory.ChunkPoolingOpenAIEmbedding')
def test_build_embedding_model_respects_nemo_embeddings_api_key(mock_ctor: MagicMock, monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', '')
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_API_KEY', 'secret-emb')

    emb, err = ef.build_embedding_model(_llamacpp_conn(embeddings_model='emb-model'))
    assert err == ''
    assert emb is mock_inst
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('api_key') == 'secret-emb'


def test_make_chunk_pooling_embedding_llamacpp_allows_hf_style_model_id() -> None:
    from clara_coder_backend.workspace_index.embeddings_factory import _make_chunk_pooling_embedding

    conn = _llamacpp_conn()
    emb = _make_chunk_pooling_embedding(
        conn,
        model='nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0',
        api_key='k',
        api_base='http://127.0.0.1:9/v1',
        timeout=30.0,
        max_retries=0,
    )
    assert emb._query_engine == 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0'
    assert emb._text_engine == 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0'
    assert emb.model_name == 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0'


def test_resolve_embedding_model_id_prefers_connection_field() -> None:
    from clara_coder_backend.workspace_index.embeddings_factory import resolve_embedding_model_id

    conn = _llamacpp_conn(embeddings_model='custom-emb-id')
    assert resolve_embedding_model_id(conn) == 'custom-emb-id'


def test_resolve_embedding_model_id_llamacpp_falls_back_to_chat_model(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef
    from clara_coder_backend.workspace_index.embeddings_factory import resolve_embedding_model_id

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', '')
    conn = _llamacpp_conn(model='my-gguf', embeddings_model='', embeddings_base_url='')
    assert resolve_embedding_model_id(conn) == 'my-gguf'


def test_resolve_embedding_model_id_uses_env_default_on_dedicated_embeddings_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef
    from clara_coder_backend.workspace_index.embeddings_factory import resolve_embedding_model_id

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', 'http://127.0.0.1:8081')
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_MODEL', 'nomic-embed-text')
    conn = _llamacpp_conn(model='my-chat-gguf', embeddings_model='')
    assert resolve_embedding_model_id(conn) == 'nomic-embed-text'


def test_resolve_embedding_model_id_uses_env_default_on_per_connection_embeddings_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef
    from clara_coder_backend.workspace_index.embeddings_factory import resolve_embedding_model_id

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', '')
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_MODEL', 'nomic-embed-text')
    conn = _llamacpp_conn(model='my-chat-gguf', embeddings_model='', embeddings_base_url='http://127.0.0.1:8081')
    assert resolve_embedding_model_id(conn) == 'nomic-embed-text'


@patch('clara_coder_backend.workspace_index.embeddings_factory.ChunkPoolingOpenAIEmbedding')
def test_build_embedding_model_skips_probe_within_ttl(mock_ctor: MagicMock, monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    ef._embedding_probe_ok_mono.clear()
    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', '')
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_API_KEY', '')

    conn = _llamacpp_conn(embeddings_model='emb-model')
    emb1, err1 = ef.build_embedding_model(conn)
    assert err1 == '' and emb1 is mock_inst
    emb2, err2 = ef.build_embedding_model(conn)
    assert err2 == '' and emb2 is mock_inst
    assert mock_inst.get_query_embedding.call_count == 1


def test_chunk_text_for_embedding_splits_long_text() -> None:
    from clara_coder_backend.workspace_index.embeddings_factory import _chunk_text_for_embedding

    long = ('word ' * 3000).strip()
    parts = _chunk_text_for_embedding(long, 64)
    assert len(parts) > 1
    assert all(p.strip() for p in parts)


def test_build_embedding_model_skips_llamacpp_chat_only_without_probe(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', '')
    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'ChunkPoolingOpenAIEmbedding', _no)

    emb, err = ef.build_embedding_model(_llamacpp_conn())
    assert emb is None
    assert 'chat-only' in err.lower()
    assert not called


def test_build_embedding_model_skips_lmstudio_without_embeddings_model(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_BASE_URL', '')
    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'ChunkPoolingOpenAIEmbedding', _no)

    emb, err = ef.build_embedding_model(_lmstudio_conn())
    assert emb is None
    assert 'embeddings model' in err.lower()
    assert not called
