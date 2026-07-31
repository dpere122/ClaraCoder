"""Tests for Qwen / model-family tuning helpers."""

import os
from dataclasses import replace

from clara_coder_backend.session.domain import RuntimeConnection
from clara_coder_backend.session import state
from clara_coder_backend.llm.model_tuning import (
    combined_model_prompt_suffix,
    connection_user_sampling_kwargs_for_llm,
    effective_parallel_tool_calls,
    gemma_sparse_expert_workspace_suffix,
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


def test_gemma_sampling_kwargs_empty_for_generic_preset() -> None:
    c = _conn(
        model='google/gemma-4-it',
        optimization_preset='generic',
        sampling_preset='gemma-recommended',
    )
    assert gemma_sampling_kwargs_for_llm(c) == {}


def test_combined_suffix_gemma_thinking_on() -> None:
    c = _conn(model='google/gemma-4-it', parallel=False, optimization_preset='gemma', thinking_mode='on')
    s = combined_model_prompt_suffix(c)
    assert 'Model note (Gemma thinking)' in s
    assert '<|channel>thought' in s
    assert 'Model note (Gemma):' in s
    assert 'transfer_staged_file_to_workspace' in s


def test_combined_suffix_gemma_sparse_expert_hint() -> None:
    c = _conn(
        model='google/gemma-4-26b-a4b-it',
        parallel=False,
        optimization_preset='gemma',
        thinking_mode='default',
        architecture_hint='auto',
    )
    s = combined_model_prompt_suffix(c)
    assert 'Model note (Gemma sparse experts)' in s
    assert 'Gemma sparse experts — workspace edits' in s
    assert 'Single-purpose mutations' in s
    assert 'Review synthesis' in s
    assert 'read_staged_edit' in s
    assert 'transfer_staged_file_to_workspace' in s


def test_combined_suffix_generic_mentions_staging_transfer() -> None:
    c = _conn(model='gpt-4o', parallel=False, optimization_preset='generic', architecture_hint='auto')
    s = combined_model_prompt_suffix(c)
    assert 'transfer_staged_file_to_workspace' in s
    assert 'land_in_workspace=true' in s


def test_gemma_sparse_expert_workspace_suffix_only_when_gemma_preset_and_sparse_model() -> None:
    dense = _conn(
        model='google/gemma-4-it',
        parallel=False,
        optimization_preset='gemma',
        architecture_hint='dense',
    )
    assert gemma_sparse_expert_workspace_suffix(dense) == ''

    sparse_model = _conn(
        model='google/gemma-4-26b-a4b-it',
        parallel=False,
        optimization_preset='gemma',
        architecture_hint='auto',
    )
    g = gemma_sparse_expert_workspace_suffix(sparse_model)
    assert 'workspace edits' in g
    assert 'stage_snippet_edit' in g
    assert 'stage_line_range_edit' in g
    assert 'when line numbers are known' in g

    generic = _conn(
        model='google/gemma-4-26b-a4b-it',
        parallel=False,
        optimization_preset='generic',
        architecture_hint='auto',
    )
    assert gemma_sparse_expert_workspace_suffix(generic) == ''


def test_gemma_sampling_recommended() -> None:
    c = _conn(model='google/gemma-4-it', optimization_preset='gemma', sampling_preset='gemma-recommended')
    kw = gemma_sampling_kwargs_for_llm(c)
    assert kw.get('top_p') == 0.95
    assert kw.get('extra_body', {}).get('top_k') == 64


def test_gemma_sampling_custom() -> None:
    c = _conn(
        model='google/gemma-4-it',
        optimization_preset='gemma',
        sampling_preset='custom',
        top_p=0.88,
        top_k=32,
    )
    kw = gemma_sampling_kwargs_for_llm(c)
    assert kw.get('top_p') == 0.88
    assert kw.get('extra_body', {}).get('top_k') == 32


def test_connection_user_sampling_generic_top_p_top_k() -> None:
    c = _conn(model='local-model', optimization_preset='generic', top_p=0.9, top_k=20)
    kw = connection_user_sampling_kwargs_for_llm(c)
    assert kw.get('top_p') == 0.9
    assert kw.get('extra_body', {}).get('top_k') == 20


def test_connection_user_sampling_gemma_recommended_skips_top_p_top_k() -> None:
    c = replace(
        _conn(
            model='google/gemma-4-it',
            optimization_preset='gemma',
            sampling_preset='gemma-recommended',
            top_p=0.1,
            top_k=3,
        ),
        min_p=0.02,
    )
    kw = connection_user_sampling_kwargs_for_llm(c)
    assert 'top_p' not in kw
    assert kw.get('extra_body') == {'min_p': 0.02}


def test_connection_user_sampling_presence_and_repeat_penalty() -> None:
    c = replace(
        _conn(model='local-model'),
        presence_penalty=-0.5,
        repeat_penalty=1.1,
    )
    kw = connection_user_sampling_kwargs_for_llm(c)
    assert kw.get('presence_penalty') == -0.5
    assert kw.get('extra_body', {}).get('repeat_penalty') == 1.1


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


def test_parallel_disabled_when_qwen_template_selected() -> None:
    c = _conn(model='local-model', parallel=True, optimization_preset='qwen')
    assert qwen_optimize_profile_active(c)
    assert not effective_parallel_tool_calls(c)


def test_parallel_respects_connection_for_generic_with_qwen_model_id() -> None:
    c = _conn(model='qwen3.5-9b', parallel=True, optimization_preset='generic')
    assert not qwen_optimize_profile_active(c)
    assert effective_parallel_tool_calls(c)


def test_qwen_preset_without_qwen_model_id() -> None:
    c = _conn(model='local-model', parallel=True, optimization_preset='qwen')
    assert qwen_optimize_profile_active(c)
    assert not effective_parallel_tool_calls(c)


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
    assert '**Workspace edits:**' in s
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
    assert '**Workspace edits:**' in s


def test_qwen_system_prompt_suffix_backward_compat() -> None:
    s = qwen_system_prompt_suffix()
    assert '**Workspace edits:**' in s
    assert 'Model note (Qwen)' in s


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
