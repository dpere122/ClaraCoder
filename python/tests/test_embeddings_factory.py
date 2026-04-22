"""Tests for :mod:`nemo_backend.workspace_index.embeddings_factory`."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from nemo_backend.domain import RuntimeConnection


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


def test_build_embedding_model_skips_llamacpp_when_chat_base_uses_port_zero(monkeypatch) -> None:
    from nemo_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_BASE_URL', '')
    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'OpenAIEmbedding', _no)

    emb, err = ef.build_embedding_model(_llamacpp_conn(base_url='http://127.0.0.1:0/v1'))
    assert emb is None
    assert 'unavailable' in err.lower()
    assert not called


def test_build_embedding_model_skips_llamacpp_when_embeddings_disabled(monkeypatch) -> None:
    from nemo_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_BASE_URL', '')
    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'OpenAIEmbedding', _no)

    emb, err = ef.build_embedding_model(_llamacpp_conn(embeddings_enabled=False))
    assert emb is None
    assert 'disabled' in err.lower()
    assert not called


@patch('nemo_backend.workspace_index.embeddings_factory.OpenAIEmbedding')
def test_build_embedding_model_llamacpp_disabled_still_uses_nemo_embeddings_url(mock_ctor: MagicMock, monkeypatch) -> None:
    from nemo_backend.workspace_index import embeddings_factory as ef

    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_BASE_URL', 'http://127.0.0.1:9000')
    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_API_KEY', '')

    emb, err = ef.build_embedding_model(_llamacpp_conn(embeddings_enabled=False))
    assert err == ''
    assert emb is mock_inst


@patch('nemo_backend.workspace_index.embeddings_factory.OpenAIEmbedding')
def test_build_embedding_model_respects_nemo_embeddings_base_url(mock_ctor: MagicMock, monkeypatch) -> None:
    from nemo_backend.workspace_index import embeddings_factory as ef

    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_BASE_URL', 'http://127.0.0.1:9000')
    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_API_KEY', '')

    emb, err = ef.build_embedding_model(_llamacpp_conn())
    assert err == ''
    assert emb is mock_inst
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('api_base') == 'http://127.0.0.1:9000/v1'


@patch('nemo_backend.workspace_index.embeddings_factory.OpenAIEmbedding')
def test_build_embedding_model_per_connection_embeddings_base_url_over_env(mock_ctor: MagicMock, monkeypatch) -> None:
    from nemo_backend.workspace_index import embeddings_factory as ef

    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_BASE_URL', 'http://127.0.0.1:9000')
    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_API_KEY', '')

    conn = _llamacpp_conn(embeddings_base_url='http://127.0.0.1:7777')
    emb, err = ef.build_embedding_model(conn)
    assert err == ''
    assert emb is mock_inst
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('api_base') == 'http://127.0.0.1:7777/v1'


@patch('nemo_backend.workspace_index.embeddings_factory.OpenAIEmbedding')
def test_build_embedding_model_respects_nemo_embeddings_api_key(mock_ctor: MagicMock, monkeypatch) -> None:
    from nemo_backend.workspace_index import embeddings_factory as ef

    mock_inst = MagicMock()
    mock_ctor.return_value = mock_inst
    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_BASE_URL', '')
    monkeypatch.setattr(ef, 'NEMO_EMBEDDINGS_API_KEY', 'secret-emb')

    emb, err = ef.build_embedding_model(_llamacpp_conn())
    assert err == ''
    assert emb is mock_inst
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('api_key') == 'secret-emb'
