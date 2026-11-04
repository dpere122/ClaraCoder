"""Tests for :func:`clara_coder_backend.llm.factory.build_llm` wiring (reasoning_effort, Gemma sampling)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from clara_coder_backend.domain import RuntimeConnection


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
        thinking_mode='default',
        sampling_preset='provider-default',
        top_p=0.95,
        top_k=64,
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
    )


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_omits_reasoning_effort_for_gemma(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn()
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert 'reasoning_effort' not in kwargs
    assert kwargs.get('top_p') == 0.95
    assert kwargs.get('extra_body', {}).get('top_k') == 64


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_lmstudio_appends_v1_when_missing(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(base_url='http://127.0.0.1:1234')
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    assert mock_ctor.call_args.kwargs.get('base_url') == 'http://127.0.0.1:1234/v1'


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
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
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('base_url') == 'http://127.0.0.1:8080/v1'
    assert kwargs.get('api_key') == 'not-needed'
    assert kwargs.get('stream_usage') is True
    assert isinstance(kwargs.get('http_client'), httpx.Client)
    assert isinstance(kwargs.get('http_async_client'), httpx.AsyncClient)


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_passes_reasoning_effort_for_openai(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _openai_conn()
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('reasoning_effort') == 'low'


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_passes_reasoning_effort_for_gemma_model_when_preset_generic(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(optimization_preset='generic')
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('reasoning_effort') == 'high'


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_sets_idle_read_timeout_and_no_retries(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
    monkeypatch,
) -> None:
    """A stalled stream must fail via httpx read timeout instead of hanging forever."""
    monkeypatch.delenv('CLARA_LLM_IDLE_TIMEOUT_SEC', raising=False)
    mock_get.return_value = _openai_conn()
    from clara_coder_backend.llm.factory import _DEFAULT_LLM_IDLE_TIMEOUT_SEC, build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    timeout = kwargs.get('timeout')
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == _DEFAULT_LLM_IDLE_TIMEOUT_SEC
    assert kwargs.get('max_retries') == 0
    assert kwargs.get('stream_chunk_timeout') == _DEFAULT_LLM_IDLE_TIMEOUT_SEC


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_idle_timeout_env_override(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
    monkeypatch,
) -> None:
    monkeypatch.setenv('CLARA_LLM_IDLE_TIMEOUT_SEC', '45')
    mock_get.return_value = _openai_conn()
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    timeout = mock_ctor.call_args.kwargs.get('timeout')
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == 45.0
    assert mock_ctor.call_args.kwargs.get('stream_chunk_timeout') == 45.0


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_idle_timeout_invalid_env_falls_back(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
    monkeypatch,
) -> None:
    monkeypatch.setenv('CLARA_LLM_IDLE_TIMEOUT_SEC', 'not-a-number')
    mock_get.return_value = _openai_conn()
    from clara_coder_backend.llm.factory import _DEFAULT_LLM_IDLE_TIMEOUT_SEC, build_llm

    build_llm()
    timeout = mock_ctor.call_args.kwargs.get('timeout')
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == _DEFAULT_LLM_IDLE_TIMEOUT_SEC


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
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
        top_p=0.95,
        top_k=20,
        min_p=0.0,
        presence_penalty=0.0,
        repeat_penalty=1.0,
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('temperature') == 0.6
    assert kwargs.get('top_p') == 0.95
    assert kwargs.get('presence_penalty') == 0.0
    eb = kwargs.get('extra_body') or {}
    assert eb.get('top_k') == 20
    assert eb.get('min_p') == 0.0
    assert eb.get('repeat_penalty') == 1.0


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_gemma_thinking_mode_on(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(thinking_mode='on')
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    ctk = (mock_ctor.call_args.kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is True


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_gemma_stops_the_empty_channel_loop_on_local_servers(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    from clara_coder_backend.llm.factory import build_llm

    mock_get.return_value = _gemma_conn()
    build_llm()
    assert mock_ctor.call_args.kwargs.get('stop') == ['<|channel>thought\n<channel|>' * 8]

    mock_get.return_value = _gemma_conn(optimization_preset='generic')
    build_llm()
    assert 'stop' not in mock_ctor.call_args.kwargs


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_gemma_thinking_mode_off(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(thinking_mode='off')
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    ctk = (mock_ctor.call_args.kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is False


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_gemma_thinking_mode_default_omits_kwarg(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(thinking_mode='default')
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    eb = mock_ctor.call_args.kwargs.get('extra_body') or {}
    assert 'chat_template_kwargs' not in eb


def _qwen_conn(**kwargs: object) -> RuntimeConnection:
    base = dict(
        id='q',
        name='q',
        provider='llamacpp',
        base_url='http://127.0.0.1:8080/v1',
        model='qwen3-8b',
        api_key='not-needed',
        reasoning_effort='',
        temperature=0.6,
        parallel_tool_calls=False,
        optimization_preset='qwen',
        max_output_tokens=0,
        thinking_mode='default',
    )
    base.update(kwargs)
    return RuntimeConnection(**base)


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_qwen_caps_enable_thinking_on(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _qwen_conn(
        thinking_mode='on',
        chat_template_reasoning={'enableThinking': True, 'reasoningEffortValues': None},
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert 'reasoning_effort' not in kwargs
    ctk = (kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is True


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_qwen_caps_effort_allow_list(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _qwen_conn(
        reasoning_effort='low',
        chat_template_reasoning={'enableThinking': False, 'reasoningEffortValues': ['xhigh', 'medium', 'low']},
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('reasoning_effort') == 'low'
    ctk = (kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('reasoning_effort') == 'low'
    assert 'enable_thinking' not in ctk


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_caps_invalid_effort_omitted(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _qwen_conn(
        reasoning_effort='high',
        chat_template_reasoning={'enableThinking': False, 'reasoningEffortValues': ['xhigh', 'medium', 'low']},
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert 'reasoning_effort' not in kwargs
    ctk = (kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert 'reasoning_effort' not in ctk


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_caps_neither_knob_omits_both(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _qwen_conn(
        reasoning_effort='high',
        thinking_mode='on',
        chat_template_reasoning={'enableThinking': False, 'reasoningEffortValues': None},
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert 'reasoning_effort' not in kwargs
    eb = kwargs.get('extra_body') or {}
    assert 'chat_template_kwargs' not in eb


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_caps_thinking_off_skips_effort(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _qwen_conn(
        reasoning_effort='xhigh',
        thinking_mode='off',
        chat_template_reasoning={'enableThinking': True, 'reasoningEffortValues': ['xhigh', 'medium', 'low']},
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert 'reasoning_effort' not in kwargs
    ctk = (kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is False
    assert 'reasoning_effort' not in ctk


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_qwen_no_caps_thinking_off(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _qwen_conn(thinking_mode='off', reasoning_effort='medium')
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert 'reasoning_effort' not in kwargs
    ctk = (kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is False


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_qwen_no_caps_thinking_on(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _qwen_conn(thinking_mode='on')
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    ctk = (mock_ctor.call_args.kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is True


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_disable_thinking_overrides_gemma_on(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _gemma_conn(thinking_mode='on')
    from clara_coder_backend.llm.factory import build_llm

    build_llm(disable_thinking=True)
    kwargs = mock_ctor.call_args.kwargs
    # This connection is LM Studio, which only turns thinking off through this value.
    assert kwargs.get('reasoning_effort') == 'none'
    ctk = (kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is False


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_disable_thinking_unknown_generic_local(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = RuntimeConnection(
        id='u',
        name='u',
        provider='llamacpp',
        base_url='http://127.0.0.1:8080/v1',
        model='mystery-reasoner-7b',
        api_key='not-needed',
        reasoning_effort='high',
        temperature=0.7,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
        thinking_mode='on',
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm(disable_thinking=True)
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('reasoning_effort') == 'none'
    ctk = (kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is False


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_disable_thinking_openai_uses_none_effort(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _openai_conn()
    from clara_coder_backend.llm.factory import build_llm

    build_llm(disable_thinking=True)
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('reasoning_effort') == 'none'
    eb = kwargs.get('extra_body') or {}
    assert 'chat_template_kwargs' not in eb


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_disable_thinking_qwen_caps_effort_allow_list(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _qwen_conn(
        thinking_mode='on',
        reasoning_effort='low',
        chat_template_reasoning={'enableThinking': True, 'reasoningEffortValues': ['xhigh', 'medium', 'low', 'none']},
    )
    from clara_coder_backend.llm.factory import build_llm

    build_llm(disable_thinking=True)
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('reasoning_effort') == 'none'
    ctk = (kwargs.get('extra_body') or {}).get('chat_template_kwargs') or {}
    assert ctk.get('enable_thinking') is False
    assert ctk.get('reasoning_effort') == 'none'


def _openrouter_conn(**kwargs: object) -> RuntimeConnection:
    base = dict(
        id='or',
        name='OpenRouter',
        provider='openrouter',
        base_url='https://openrouter.ai/api',
        model='anthropic/claude-sonnet-4.5',
        api_key='sk-or-test',
        reasoning_effort='low',
        temperature=0.2,
        parallel_tool_calls=True,
        optimization_preset='generic',
        max_output_tokens=0,
        top_p=0.9,
        top_k=40,
        min_p=0.05,
        repeat_penalty=1.1,
    )
    base.update(kwargs)
    return RuntimeConnection(**base)


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_openrouter_headers_reasoning_and_no_llama_extra(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _openrouter_conn()
    from clara_coder_backend.llm.factory import OPENROUTER_APP_TITLE, OPENROUTER_HTTP_REFERER, build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert kwargs.get('base_url') == 'https://openrouter.ai/api/v1'
    assert kwargs.get('api_key') == 'sk-or-test'
    assert kwargs.get('default_headers') == {
        'HTTP-Referer': OPENROUTER_HTTP_REFERER,
        'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
    }
    assert OPENROUTER_HTTP_REFERER == 'https://clara.coder'
    assert OPENROUTER_APP_TITLE == 'Clara Coder'
    assert 'reasoning_effort' not in kwargs
    assert kwargs.get('top_p') == 0.9
    eb = kwargs.get('extra_body') or {}
    assert eb.get('reasoning') == {'effort': 'low'}
    assert 'top_k' not in eb
    assert 'min_p' not in eb
    assert 'repeat_penalty' not in eb
    assert 'chat_template_kwargs' not in eb


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_openrouter_omits_reasoning_when_default(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    mock_get.return_value = _openrouter_conn(reasoning_effort='', top_k=None, min_p=None, repeat_penalty=None, top_p=None)
    from clara_coder_backend.llm.factory import build_llm

    build_llm()
    kwargs = mock_ctor.call_args.kwargs
    assert 'reasoning_effort' not in kwargs
    eb = kwargs.get('extra_body') or {}
    assert 'reasoning' not in eb
    assert 'chat_template_kwargs' not in eb


def _build_openrouter_kwargs(mock_get: MagicMock, mock_ctor: MagicMock, *, disable_thinking: bool = False, **conn: object) -> dict:
    mock_get.return_value = _openrouter_conn(top_k=None, min_p=None, repeat_penalty=None, **conn)
    from clara_coder_backend.llm.factory import build_llm

    build_llm(disable_thinking=disable_thinking)
    return mock_ctor.call_args.kwargs


_OPTIONAL_CAPS = {'enableThinking': True, 'reasoningEffortValues': ['low', 'medium', 'high']}
_MANDATORY_CAPS = {'enableThinking': False, 'reasoningEffortValues': ['low', 'medium', 'high', 'xhigh', 'max']}


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_openrouter_toggle_off_sends_none_when_reasoning_optional(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    kwargs = _build_openrouter_kwargs(
        mock_get, mock_ctor, thinking_mode='off', reasoning_effort='high', chat_template_reasoning=_OPTIONAL_CAPS
    )
    assert (kwargs.get('extra_body') or {}).get('reasoning') == {'effort': 'none'}


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_openrouter_mandatory_ignores_saved_off_and_keeps_effort(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    kwargs = _build_openrouter_kwargs(
        mock_get, mock_ctor, thinking_mode='off', reasoning_effort='max', chat_template_reasoning=_MANDATORY_CAPS
    )
    assert (kwargs.get('extra_body') or {}).get('reasoning') == {'effort': 'max'}


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_openrouter_disable_thinking_never_sends_none_to_mandatory(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    kwargs = _build_openrouter_kwargs(
        mock_get, mock_ctor, disable_thinking=True, reasoning_effort='high', chat_template_reasoning=_MANDATORY_CAPS
    )
    assert 'reasoning' not in (kwargs.get('extra_body') or {})


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_openrouter_toggle_on_with_default_effort_enables_reasoning(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    kwargs = _build_openrouter_kwargs(
        mock_get, mock_ctor, thinking_mode='on', reasoning_effort='', chat_template_reasoning=_OPTIONAL_CAPS
    )
    assert (kwargs.get('extra_body') or {}).get('reasoning') == {'enabled': True}


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_openrouter_drops_effort_the_model_does_not_advertise(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    kwargs = _build_openrouter_kwargs(
        mock_get, mock_ctor, reasoning_effort='xhigh', chat_template_reasoning=_OPTIONAL_CAPS
    )
    assert 'reasoning' not in (kwargs.get('extra_body') or {})


def _lmstudio_kwargs(mock_get: MagicMock, mock_ctor: MagicMock, *, disable_thinking: bool = False, **conn: object) -> dict:
    mock_get.return_value = _gemma_conn(**conn)
    from clara_coder_backend.llm.factory import build_llm

    build_llm(disable_thinking=disable_thinking)
    return mock_ctor.call_args.kwargs


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_lmstudio_thinking_off_sends_reasoning_effort_none(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    """LM Studio ignores ``enable_thinking`` on chat completions; only this value turns thinking off."""
    assert _lmstudio_kwargs(mock_get, mock_ctor, thinking_mode='off').get('reasoning_effort') == 'none'


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_lmstudio_internal_calls_pin_thinking_off(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    caps = {'enableThinking': True, 'reasoningEffortValues': None}
    kwargs = _lmstudio_kwargs(mock_get, mock_ctor, disable_thinking=True, chat_template_reasoning=caps)
    assert kwargs.get('reasoning_effort') == 'none'


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_lmstudio_thinking_on_leaves_the_model_default(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    caps = {'enableThinking': True, 'reasoningEffortValues': None}
    kwargs = _lmstudio_kwargs(mock_get, mock_ctor, thinking_mode='on', chat_template_reasoning=caps)
    assert 'reasoning_effort' not in kwargs


@patch('clara_coder_backend.llm.factory.ChatOpenAI')
@patch('clara_coder_backend.llm.factory.log_llm_connection_settings')
@patch('clara_coder_backend.llm.factory.get_active_connection')
def test_build_llm_lmstudio_sends_idle_ttl_only_when_set(
    mock_get: MagicMock,
    _mock_log: MagicMock,
    mock_ctor: MagicMock,
) -> None:
    assert (_lmstudio_kwargs(mock_get, mock_ctor, idle_ttl_seconds=300).get('extra_body') or {}).get('ttl') == 300
    assert 'ttl' not in (_lmstudio_kwargs(mock_get, mock_ctor).get('extra_body') or {})

def _compat_conn(compat: dict | None = None, **kwargs: object) -> RuntimeConnection:
    base = dict(
        id='c',
        name='c',
        provider='openai-compatible',
        base_url='https://x.dev/v1',
        model='m',
        api_key='k',
        reasoning_effort='',
        temperature=0.5,
        parallel_tool_calls=True,
        optimization_preset='generic',
        max_output_tokens=0,
        thinking_mode='default',
        sampling_preset='provider-default',
        architecture_hint='auto',
        open_ai_compat=compat or {},
    )
    base.update(kwargs)
    return RuntimeConnection(**base)  # type: ignore[arg-type]


def _compat_kwargs(mock_get: MagicMock, mock_ctor: MagicMock, conn: RuntimeConnection, *, disable_thinking: bool = False) -> dict:
    mock_get.return_value = conn
    from clara_coder_backend.llm.factory import build_llm

    build_llm(disable_thinking=disable_thinking)
    return mock_ctor.call_args.kwargs


COMPAT_PATCHES = (
    'clara_coder_backend.llm.factory.ChatOpenAI',
    'clara_coder_backend.llm.factory.log_llm_connection_settings',
    'clara_coder_backend.llm.factory.get_active_connection',
)


def _with_compat(test):
    """Runs ``test(mock_get, mock_ctor, mock_log)`` with the factory's collaborators patched."""

    def run() -> None:
        with patch(COMPAT_PATCHES[0]) as ctor, patch(COMPAT_PATCHES[1]) as log, patch(COMPAT_PATCHES[2]) as get:
            test(get, ctor, log)

    run.__name__ = test.__name__
    return run


@_with_compat
def test_compat_sends_nothing_llama_server_specific(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    kwargs = _compat_kwargs(get, ctor, _compat_conn(top_k=40, min_p=0.1, repeat_penalty=1.1, thinking_mode='off'))
    assert 'extra_body' not in kwargs
    assert 'reasoning_effort' not in kwargs
    assert 'max_tokens' not in kwargs


@_with_compat
def test_compat_refuses_to_default_to_openai_without_a_url(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        _compat_kwargs(get, ctor, _compat_conn(base_url=''))
    ctor.assert_not_called()


@_with_compat
def test_compat_works_without_an_api_key(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    assert _compat_kwargs(get, ctor, _compat_conn(api_key=''))['api_key'] == 'not-needed'


@_with_compat
def test_compat_max_tokens_goes_in_the_body_since_langchain_renames_its_own(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    kwargs = _compat_kwargs(get, ctor, _compat_conn({'tokensField': 'max_tokens'}, max_output_tokens=500))
    assert 'max_tokens' not in kwargs
    assert kwargs['extra_body']['max_tokens'] == 500


@_with_compat
def test_compat_max_completion_tokens_uses_langchains_rename(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    kwargs = _compat_kwargs(get, ctor, _compat_conn({'tokensField': 'max_completion_tokens'}, max_output_tokens=500))
    assert kwargs['max_tokens'] == 500
    assert 'extra_body' not in kwargs


@_with_compat
def test_compat_can_leave_temperature_out(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    assert _compat_kwargs(get, ctor, _compat_conn({'sendTemperature': False}))['temperature'] is None
    assert _compat_kwargs(get, ctor, _compat_conn())['temperature'] == 0.5


@_with_compat
def test_compat_stream_usage_follows_the_setting(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    assert _compat_kwargs(get, ctor, _compat_conn({'streamUsage': False}))['stream_usage'] is False
    assert _compat_kwargs(get, ctor, _compat_conn())['stream_usage'] is True


@_with_compat
def test_compat_standard_request_fields(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    kwargs = _compat_kwargs(get, ctor, _compat_conn({'frequencyPenalty': 0.2, 'seed': 7, 'stop': ['END']}, top_p=0.9, presence_penalty=0.1))
    assert kwargs['frequency_penalty'] == 0.2
    assert kwargs['seed'] == 7
    assert kwargs['stop'] == ['END']
    assert kwargs['top_p'] == 0.9
    assert kwargs['presence_penalty'] == 0.1


@_with_compat
def test_compat_gemma_profile_keeps_the_channel_loop_stop(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    loop_stop = '<|channel>thought\n<channel|>' * 8
    kwargs = _compat_kwargs(get, ctor, _compat_conn({'stop': ['END']}, optimization_preset='gemma'))
    assert kwargs['stop'] == [loop_stop, 'END']
    assert 'stop' not in _compat_kwargs(get, ctor, _compat_conn())


@_with_compat
def test_compat_non_standard_sampling_only_when_turned_on(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    conn = dict(top_k=40, min_p=0.1, repeat_penalty=1.1)
    assert 'extra_body' not in _compat_kwargs(get, ctor, _compat_conn(**conn))
    body = _compat_kwargs(get, ctor, _compat_conn({'nonStandardSampling': True}, **conn))['extra_body']
    assert body == {'top_k': 40, 'min_p': 0.1, 'repeat_penalty': 1.1}


@pytest.mark.parametrize(
    ('method', 'mode', 'effort', 'expected_effort', 'expected_body'),
    [
        ('none', 'off', '', None, None),
        ('reasoning_effort', 'off', '', 'none', None),
        ('reasoning_effort', 'default', 'high', 'high', None),
        ('reasoning_effort', 'default', '', None, None),
        ('reasoning', 'off', '', None, {'reasoning': {'effort': 'none'}}),
        ('reasoning', 'default', 'low', None, {'reasoning': {'effort': 'low'}}),
        ('chat_template_kwargs', 'off', '', None, {'chat_template_kwargs': {'enable_thinking': False}}),
        ('chat_template_kwargs', 'on', '', None, {'chat_template_kwargs': {'enable_thinking': True}}),
        ('chat_template_kwargs', 'default', '', None, None),
    ],
)
def test_compat_thinking_methods(method: str, mode: str, effort: str, expected_effort: str | None, expected_body: dict | None) -> None:
    with patch(COMPAT_PATCHES[0]) as ctor, patch(COMPAT_PATCHES[1]), patch(COMPAT_PATCHES[2]) as get:
        kwargs = _compat_kwargs(get, ctor, _compat_conn({'thinkingMethod': method}, thinking_mode=mode, reasoning_effort=effort))
    assert kwargs.get('reasoning_effort') == expected_effort
    assert kwargs.get('extra_body') == expected_body


@_with_compat
def test_compat_internal_calls_pin_thinking_off_by_the_servers_method(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    kwargs = _compat_kwargs(get, ctor, _compat_conn({'thinkingMethod': 'chat_template_kwargs'}), disable_thinking=True)
    assert kwargs['extra_body'] == {'chat_template_kwargs': {'enable_thinking': False}}


@_with_compat
def test_compat_extra_body_merges_but_cannot_replace_what_the_agent_builds(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    text = '{"custom": 1, "model": "x", "messages": [], "tools": [], "stream": false}'
    assert _compat_kwargs(get, ctor, _compat_conn({'extraBody': text}))['extra_body'] == {'custom': 1}


@pytest.mark.parametrize('text', ['{not json', '[1]', '   '])
def test_compat_bad_extra_body_is_skipped_not_fatal(text: str) -> None:
    with patch(COMPAT_PATCHES[0]) as ctor, patch(COMPAT_PATCHES[1]), patch(COMPAT_PATCHES[2]) as get:
        assert 'extra_body' not in _compat_kwargs(get, ctor, _compat_conn({'extraBody': text}))


@_with_compat
def test_compat_custom_headers_are_sent_but_never_logged(get: MagicMock, ctor: MagicMock, log: MagicMock) -> None:
    kwargs = _compat_kwargs(get, ctor, _compat_conn({'extraBody': '{"token": "body-secret"}'}, custom_headers={'api-key': 'hdr-secret'}))
    assert kwargs['default_headers'] == {'api-key': 'hdr-secret'}
    logged = str(log.call_args)
    assert 'hdr-secret' not in logged
    assert 'body-secret' not in logged


def test_parallel_tool_calls_field_can_be_left_out() -> None:
    from clara_coder_backend.llm.model_tuning import sends_parallel_tool_calls_field

    assert sends_parallel_tool_calls_field(_compat_conn({'sendParallelToolCalls': False})) is False
    assert sends_parallel_tool_calls_field(_compat_conn()) is True
    assert sends_parallel_tool_calls_field(_gemma_conn()) is True
