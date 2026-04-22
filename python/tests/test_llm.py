"""Tests for :func:`nemo_backend.llm.build_llm` wiring (reasoning_effort, Gemma sampling)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

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
