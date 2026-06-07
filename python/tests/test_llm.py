"""Tests for :func:`nemo_backend.llm.build_llm` wiring (reasoning_effort, Gemma sampling)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx

from nemo_backend.domain import RuntimeConnection


def _gemma_conn(**kwargs: object) -> RuntimeConnection:
    base = dict(
        id='t',
        name='t',
        provider='lmstudio',
        base_url='http://127.0.0.1:1234/v1',
        model='google/gemma-4-E4B-it',
        api_key='lm-studio',
        reasoning_effort='high',
        temperature=1.0,
        parallel_tool_calls=False,
        optimization_preset='gemma',
        max_output_tokens=0,
        plan_retry_attempts_count=2,
        thinking_mode='default',
        sampling_preset='gemma-recommended',
        top_p=None,
        top_k=None,
        architecture_hint='auto',
    )
    base.update(kwargs)
    return RuntimeConnection(**base)


def _openai_conn() -> RuntimeConnection:
    return RuntimeConnection(
        id='o',
        name='o',
        provider='openai',
        base_url='',
        model='gpt-4o-mini',
        api_key='sk-test',
        reasoning_effort='low',
        temperature=0.2,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
        plan_retry_attempts_count=2,
    )


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_omits_reasoning_effort_for_gemma(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn()
    from nemo_backend.llm import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert 'reasoning_effort' not in kwargs
    assert kwargs.get('top_p') == 0.95
    assert kwargs.get('extra_body', {}).get('top_k') == 64


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_llamacpp_defaults_base_url(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = RuntimeConnection(
        id='l',
        name='l',
        provider='llamacpp',
        base_url='',
        model='local-model',
        api_key='',
        reasoning_effort='',
        temperature=0.0,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
        plan_retry_attempts_count=2,
    )
    from nemo_backend.llm import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('base_url') == 'http://127.0.0.1:8080/v1'
    assert kwargs.get('api_key') == 'not-needed'
    assert kwargs.get('stream_usage') is True


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_passes_reasoning_effort_for_openai(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _openai_conn()
    from nemo_backend.llm import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('reasoning_effort') == 'low'


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_passes_reasoning_effort_for_gemma_model_when_preset_generic(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(optimization_preset='generic')
    from nemo_backend.llm import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('reasoning_effort') == 'high'


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_sets_idle_read_timeout_and_no_retries(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
    monkeypatch,
) -> None:
    """A stalled stream must fail via httpx read timeout instead of hanging forever."""
    monkeypatch.delenv('NEMO_LLM_IDLE_TIMEOUT_SEC', raising=False)
    mock_get.return_value = _openai_conn()
    from nemo_backend.llm import _DEFAULT_LLM_IDLE_TIMEOUT_SEC, build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    timeout = kwargs.get('timeout')
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == _DEFAULT_LLM_IDLE_TIMEOUT_SEC
    assert kwargs.get('max_retries') == 0


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_idle_timeout_env_override(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
    monkeypatch,
) -> None:
    monkeypatch.setenv('NEMO_LLM_IDLE_TIMEOUT_SEC', '45')
    mock_get.return_value = _openai_conn()
    from nemo_backend.llm import build_llm

    build_llm()
    timeout = mock_ctor.call_args.kwargs.get('timeout')
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == 45.0


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_idle_timeout_invalid_env_falls_back(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
    monkeypatch,
) -> None:
    monkeypatch.setenv('NEMO_LLM_IDLE_TIMEOUT_SEC', 'not-a-number')
    mock_get.return_value = _openai_conn()
    from nemo_backend.llm import _DEFAULT_LLM_IDLE_TIMEOUT_SEC, build_llm

    build_llm()
    timeout = mock_ctor.call_args.kwargs.get('timeout')
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == _DEFAULT_LLM_IDLE_TIMEOUT_SEC


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_generic_merges_optional_sampling(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = RuntimeConnection(
        id='l',
        name='l',
        provider='llamacpp',
        base_url='',
        model='local-model',
        api_key='',
        reasoning_effort='',
        temperature=0.6,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
        plan_retry_attempts_count=2,
        top_p=0.95,
        top_k=20,
        min_p=0.0,
        presence_penalty=0.0,
        repeat_penalty=1.0,
    )
    from nemo_backend.llm import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('temperature') == 0.6
    assert kwargs.get('top_p') == 0.95
    assert kwargs.get('presence_penalty') == 0.0
    eb = kwargs.get('extra_body') or {}
    assert eb.get('top_k') == 20
    assert eb.get('min_p') == 0.0
    assert eb.get('repeat_penalty') == 1.0


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_gemma_thinking_mode_on(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(thinking_mode='on')
    from nemo_backend.llm import build_llm

    build_llm()
    ctk = (mock_ctor.call_args.kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is True


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_gemma_thinking_mode_off(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(thinking_mode='off')
    from nemo_backend.llm import build_llm

    build_llm()
    ctk = (mock_ctor.call_args.kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is False


@patch('nemo_backend.llm.ChatOpenAI')
@patch('nemo_backend.llm.log_llm_connection_settings')
@patch('nemo_backend.llm.get_active_connection')
def test_build_llm_gemma_thinking_mode_default_omits_kwarg(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(thinking_mode='default')
    from nemo_backend.llm import build_llm

    build_llm()
    eb = mock_ctor.call_args.kwargs.get('extra_body') or {}
    assert 'chat_template_kwargs' not in eb
