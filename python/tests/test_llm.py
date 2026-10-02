"""Tests for :func:`clara_coder_backend.llm.factory.build_llm` wiring (reasoning_effort, Gemma sampling)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx

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
    assert 'reasoning_effort' not in kwargs
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
