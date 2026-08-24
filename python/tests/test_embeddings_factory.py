"""Tests for :mod:`clara_coder_backend.workspace_index.embeddings_factory`."""

from __future__ import annotations

import threading
import time
from unittest.mock import MagicMock

import pytest

from clara_coder_backend.domain import RuntimeConnection


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
        'embeddings_enabled': False,
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
        'embeddings_enabled': False,
    }
    base.update(kwargs)
    return RuntimeConnection(**base)  # type: ignore[arg-type]


def _openai_conn(**kwargs: object) -> RuntimeConnection:
    base: dict[str, object] = {
        'id': 'c',
        'name': 'c',
        'provider': 'openai',
        'base_url': 'https://api.openai.com/v1',
        'model': 'gpt-4o',
        'api_key': 'sk-test',
        'reasoning_effort': '',
        'temperature': 0.0,
        'parallel_tool_calls': False,
        'optimization_preset': 'generic',
        'max_output_tokens': 0,
        'embeddings_enabled': False,
    }
    base.update(kwargs)
    return RuntimeConnection(**base)  # type: ignore[arg-type]


def test_build_embedding_model_uses_cpu_nomic_for_llamacpp(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    mock_cpu = MagicMock()
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'build_fastembed_embedding', lambda: (mock_cpu, ''))

    emb, err = ef.build_embedding_model(_llamacpp_conn())
    assert err == ''
    assert emb is mock_cpu


def test_build_embedding_model_uses_cpu_nomic_for_lmstudio(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    mock_cpu = MagicMock()
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'build_fastembed_embedding', lambda: (mock_cpu, ''))

    emb, err = ef.build_embedding_model(_lmstudio_conn())
    assert err == ''
    assert emb is mock_cpu


def test_build_embedding_model_uses_cpu_nomic_for_openai(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    mock_cpu = MagicMock()
    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'build_fastembed_embedding', lambda: (mock_cpu, ''))

    emb, err = ef.build_embedding_model(_openai_conn())
    assert err == ''
    assert emb is mock_cpu


def test_build_embedding_model_skips_when_chat_server_not_running(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'build_fastembed_embedding', _no)

    emb, err = ef.build_embedding_model(
        _llamacpp_conn(base_url='http://127.0.0.1:0/v1'),
    )
    assert emb is None
    assert 'not running' in err.lower()
    assert not called


def test_build_embedding_model_skips_when_no_chat_model(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'build_fastembed_embedding', _no)

    emb, err = ef.build_embedding_model(_llamacpp_conn(model=''))
    assert emb is None
    assert 'no chat model' in err.lower()
    assert not called


def test_build_embedding_model_skips_when_cpu_disabled(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', False)
    monkeypatch.setattr(ef, 'build_fastembed_embedding', _no)

    emb, err = ef.build_embedding_model(_llamacpp_conn())
    assert emb is None
    assert 'cpu' in err.lower() or 'disabled' in err.lower()
    assert not called


def test_build_embedding_model_skips_unsupported_provider(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    called: list[object] = []

    def _no(*_a: object, **_k: object) -> None:
        called.append(True)

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'build_fastembed_embedding', _no)

    emb, err = ef.build_embedding_model(
        _llamacpp_conn(provider='python-t2i'),
    )
    assert emb is None
    assert 'unsupported' in err.lower()
    assert not called


def test_resolve_embedding_model_id_always_returns_nomic() -> None:
    from clara_coder_backend.workspace_index.embeddings_factory import resolve_embedding_model_id

    conn = _llamacpp_conn(embeddings_model='custom-emb-id')
    assert resolve_embedding_model_id(conn) == 'nomic-ai/nomic-embed-text-v1.5'


def test_embeddings_available_true_when_chat_connected(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    ok, reason = ef.embeddings_available(_llamacpp_conn())
    assert ok is True
    assert reason == ''


def test_embeddings_available_false_when_chat_not_connected(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    ok, reason = ef.embeddings_available(_llamacpp_conn(model=''))
    assert ok is False
    assert 'no chat model' in reason.lower()


def test_embeddings_available_false_when_cpu_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', False)
    ok, reason = ef.embeddings_available(_llamacpp_conn())
    assert ok is False
    assert 'disabled' in reason.lower()


def test_preload_embedding_model_triggers_background_load(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    loaded: list[str] = []
    event = threading.Event()

    def _fake_engine(_name: str, _cache: object) -> object:
        loaded.append('loaded')
        event.set()
        return MagicMock()

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'get_text_embedding_engine', _fake_engine)
    # Reset preload guard.
    ef._preloaded_key = None
    ef._preload_in_flight = None

    ef.preload_embedding_model(_llamacpp_conn())
    assert event.wait(timeout=5)
    assert loaded == ['loaded']


def test_preload_embedding_model_skips_when_chat_not_connected(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    loaded: list[str] = []

    def _no(*_a: object, **_k: object) -> None:
        loaded.append('loaded')

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'get_text_embedding_engine', _no)
    ef._preloaded_key = None
    ef._preload_in_flight = None

    ef.preload_embedding_model(_llamacpp_conn(model=''))
    assert loaded == []


def test_preload_embedding_model_retries_after_failure(monkeypatch) -> None:
    from clara_coder_backend.workspace_index import embeddings_factory as ef

    calls: list[str] = []
    fail_done = threading.Event()
    success_done = threading.Event()

    def _fail_then_ok(_name: str, _cache: object) -> object:
        if not calls:
            calls.append('fail')
            fail_done.set()
            raise RuntimeError('transient preload error')
        calls.append('ok')
        success_done.set()
        return MagicMock()

    monkeypatch.setattr(ef, 'CLARA_EMBEDDINGS_CPU_ENABLED', True)
    monkeypatch.setattr(ef, 'get_text_embedding_engine', _fail_then_ok)
    ef._preloaded_key = None
    ef._preload_in_flight = None

    conn = _llamacpp_conn()
    ef.preload_embedding_model(conn)
    assert fail_done.wait(timeout=5)
    for _ in range(50):
        if ef._preload_in_flight is None:
            break
        time.sleep(0.02)
    else:
        raise AssertionError('preload in-flight was not cleared after failure')
    assert ef._preloaded_key is None

    ef.preload_embedding_model(conn)
    assert success_done.wait(timeout=5)
    assert calls == ['fail', 'ok']
    for _ in range(50):
        if ef._preloaded_key is not None:
            break
        time.sleep(0.02)
    assert ef._preloaded_key is not None

    ef.preload_embedding_model(conn)
    time.sleep(0.15)
    assert calls == ['fail', 'ok']
