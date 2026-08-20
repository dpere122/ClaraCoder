"""Tests for Qwen / model-family tuning helpers."""

import os
from dataclasses import replace

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.session import state
from clara_coder_backend.llm.model_tuning import (
    combined_model_prompt_suffix,
    connection_user_sampling_kwargs_for_llm,
    effective_parallel_tool_calls,
    gemma_optimize_profile_active,
    gemma_sampling_kwargs_for_llm,
    is_gemma_family,
    is_qwen_family,
    llm_optional_kwargs,
    qwen_optimize_profile_active,
    qwen_system_prompt_suffix,
)


def _conn(
    *,
    model: str,
    parallel: bool = True,
    optimization_preset: str = 'generic',
    max_output_tokens: int = 0,
    thinking_mode: str = 'default',
    architecture_hint: str = 'auto',
    sampling_preset: str = 'provider-default',
    top_p: float | None = None,
    top_k: int | None = None,
) -> RuntimeConnection:
    return RuntimeConnection(
        id='t',
        name='t',
        provider='lmstudio',
        base_url='http://127.0.0.1:1234/v1',
        model=model,
        parallel_tool_calls=parallel,
        optimization_preset=optimization_preset,
        max_output_tokens=max_output_tokens,
        thinking_mode=thinking_mode,
        architecture_hint=architecture_hint,
        sampling_preset=sampling_preset,
        top_p=top_p,
        top_k=top_k,
    )


def test_is_qwen_family() -> None:
    assert is_qwen_family('Qwen3.5-9B')
    assert is_qwen_family('qwen2.5-coder-7b')
    assert not is_qwen_family('gpt-4o-mini')


def test_is_gemma_family() -> None:
    assert is_gemma_family('google/gemma-4-E4B-it')
    assert is_gemma_family('Gemma-3-12B')
    assert not is_gemma_family('gpt-4o-mini')


def test_gemma_optimize_profile_preset() -> None:
    c = _conn(model='local-model', optimization_preset='gemma')
    assert gemma_optimize_profile_active(c)


def test_gemma_optimize_profile_generic_even_when_model_id_gemma() -> None:
    assert not gemma_optimize_profile_active(_conn(model='google/gemma-4-it', optimization_preset='generic'))


def test_qwen_optimize_profile_generic_even_when_model_id_qwen() -> None:
    assert not qwen_optimize_profile_active(_conn(model='qwen3.5-9b', optimization_preset='generic'))


def test_gemma_sampling_kwargs_always_empty() -> None:
    c = _conn(
        model='google/gemma-4-it',
        optimization_preset='gemma',
        sampling_preset='gemma-recommended',
        top_p=0.95,
        top_k=64,
    )
    assert gemma_sampling_kwargs_for_llm(c) == {}


def test_combined_suffix_gemma_has_no_family_prompt_notes() -> None:
    c = _conn(model='google/gemma-4-it', parallel=False, optimization_preset='gemma', thinking_mode='on')
    s = combined_model_prompt_suffix(c)
    assert 'Model note (tools)' in s
    assert 'Model note (Gemma' not in s
    assert '<|channel>thought' not in s
    assert 'sparse experts' not in s
    assert 'one tool call per assistant turn' not in s


def test_combined_suffix_does_not_restate_edit_semantics() -> None:
    c = _conn(model='gpt-4o', parallel=False, optimization_preset='generic', architecture_hint='auto')
    s = combined_model_prompt_suffix(c)
    assert 'Model note (tools)' in s
    assert 'API tool channel' in s
    assert '**Edit semantics' not in s
    assert '**Workspace edits:**' not in s
    assert 'land_in_workspace=true' not in s


def test_connection_user_sampling_generic_top_p_top_k() -> None:
    c = _conn(model='local-model', optimization_preset='generic', top_p=0.9, top_k=20)
    kw = connection_user_sampling_kwargs_for_llm(c)
    assert kw.get('top_p') == 0.9
    assert kw.get('extra_body', {}).get('top_k') == 20


def test_connection_user_sampling_gemma_uses_connection_top_p_top_k() -> None:
    c = replace(
        _conn(
            model='google/gemma-4-it',
            optimization_preset='gemma',
            sampling_preset='provider-default',
            top_p=0.95,
            top_k=64,
        ),
        min_p=0.02,
    )
    kw = connection_user_sampling_kwargs_for_llm(c)
    assert kw.get('top_p') == 0.95
    assert kw.get('extra_body') == {'top_k': 64, 'min_p': 0.02}


def test_connection_user_sampling_presence_and_repeat_penalty() -> None:
    c = replace(
        _conn(model='local-model'),
        presence_penalty=-0.5,
        repeat_penalty=1.1,
    )
    kw = connection_user_sampling_kwargs_for_llm(c)
    assert kw.get('presence_penalty') == -0.5
    assert kw.get('extra_body', {}).get('repeat_penalty') == 1.1


def test_llm_optional_max_tokens_omitted_when_zero() -> None:
    prev_global = os.environ.get('CLARA_CHAT_MAX_OUTPUT_TOKENS')
    prev_qwen = os.environ.get('CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS')
    prev_gemma = os.environ.get('CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS')
    try:
        os.environ.pop('CLARA_CHAT_MAX_OUTPUT_TOKENS', None)
        os.environ.pop('CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS', None)
        os.environ.pop('CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS', None)
        qwen = _conn(model='local-model', optimization_preset='qwen', max_output_tokens=0)
        gemma = _conn(model='local-model', optimization_preset='gemma', max_output_tokens=0)
        generic = _conn(model='gpt-4', optimization_preset='generic', max_output_tokens=0)
        assert llm_optional_kwargs(qwen) == {}
        assert llm_optional_kwargs(gemma) == {}
        assert llm_optional_kwargs(generic) == {}
    finally:
        for key, val in (
            ('CLARA_CHAT_MAX_OUTPUT_TOKENS', prev_global),
            ('CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS', prev_qwen),
            ('CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS', prev_gemma),
        ):
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val


def test_llm_optional_max_tokens_for_gemma_template() -> None:
    prev_global = os.environ.get('CLARA_CHAT_MAX_OUTPUT_TOKENS')
    prev_gemma = os.environ.get('CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS')
    try:
        os.environ.pop('CLARA_CHAT_MAX_OUTPUT_TOKENS', None)
        os.environ['CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS'] = '8192'
        c = _conn(model='local-model', optimization_preset='gemma', max_output_tokens=0)
        assert llm_optional_kwargs(c) == {'max_tokens': 8192}
    finally:
        for key, val in (
            ('CLARA_CHAT_MAX_OUTPUT_TOKENS', prev_global),
            ('CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS', prev_gemma),
        ):
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val


def test_parallel_follows_connection_when_qwen_template_selected() -> None:
    on = _conn(model='local-model', parallel=True, optimization_preset='qwen')
    assert qwen_optimize_profile_active(on)
    assert effective_parallel_tool_calls(on)
    off = _conn(model='local-model', parallel=False, optimization_preset='qwen')
    assert not effective_parallel_tool_calls(off)


def test_parallel_respects_connection_for_generic_with_qwen_model_id() -> None:
    c = _conn(model='qwen3.5-9b', parallel=True, optimization_preset='generic')
    assert not qwen_optimize_profile_active(c)
    assert effective_parallel_tool_calls(c)


def test_qwen_preset_without_qwen_model_id() -> None:
    c = _conn(model='local-model', parallel=True, optimization_preset='qwen')
    assert qwen_optimize_profile_active(c)


def test_connection_max_output_tokens_override() -> None:
    prev_global = os.environ.get('CLARA_CHAT_MAX_OUTPUT_TOKENS')
    try:
        os.environ.pop('CLARA_CHAT_MAX_OUTPUT_TOKENS', None)
        c = _conn(model='gpt-4', parallel=True, optimization_preset='generic', max_output_tokens=2048)
        assert llm_optional_kwargs(c) == {'max_tokens': 2048}
    finally:
        if prev_global is None:
            os.environ.pop('CLARA_CHAT_MAX_OUTPUT_TOKENS', None)
        else:
            os.environ['CLARA_CHAT_MAX_OUTPUT_TOKENS'] = prev_global


def test_combined_suffix_includes_universal_tool_rules_for_non_qwen() -> None:
    c = _conn(model='gpt-4o', parallel=False, optimization_preset='generic')
    s = combined_model_prompt_suffix(c)
    assert 'Model note (tools)' in s
    assert 'API tool channel' in s
    assert 'Model note (Qwen)' not in s
    assert 'parallel tools' not in s


def test_combined_suffix_parallel_hint_when_parallel_enabled() -> None:
    c = _conn(model='gpt-4o', parallel=True, optimization_preset='generic')
    s = combined_model_prompt_suffix(c)
    assert 'parallel tools' in s


def test_combined_suffix_qwen_extra_when_qwen_preset() -> None:
    c = _conn(model='local-model', parallel=True, optimization_preset='qwen')
    s = combined_model_prompt_suffix(c)
    assert 'Model note (Qwen)' in s
    assert 'Model note (tools)' in s
    assert 'one tool call per assistant turn' not in s
    assert '**Edit semantics' not in s


def test_qwen_system_prompt_suffix_backward_compat() -> None:
    s = qwen_system_prompt_suffix()
    assert 'Model note (tools)' in s
    assert 'Model note (Qwen)' in s
    assert 'one tool call per assistant turn' not in s
    assert '**Edit semantics' not in s


def test_llm_optional_max_tokens_for_qwen_template() -> None:
    prev_global = os.environ.get('CLARA_CHAT_MAX_OUTPUT_TOKENS')
    prev_qwen = os.environ.get('CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS')
    try:
        os.environ.pop('CLARA_CHAT_MAX_OUTPUT_TOKENS', None)
        os.environ['CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS'] = '4096'
        c = _conn(model='gpt-4', optimization_preset='qwen', max_output_tokens=0)
        assert llm_optional_kwargs(c) == {'max_tokens': 4096}
    finally:
        for key, val in (
            ('CLARA_CHAT_MAX_OUTPUT_TOKENS', prev_global),
            ('CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS', prev_qwen),
        ):
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
