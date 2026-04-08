"""Tests for Qwen / model-family tuning helpers."""

import os

from nemo_backend.domain import RuntimeConnection
from nemo_backend.model_tuning import (
    combined_model_prompt_suffix,
    effective_parallel_tool_calls,
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
    )


def test_is_qwen_family() -> None:
    assert is_qwen_family('Qwen3.5-9B')
    assert is_qwen_family('qwen2.5-coder-7b')
    assert not is_qwen_family('gpt-4o-mini')


def test_parallel_disabled_for_qwen_when_optimize_on() -> None:
    prev = os.environ.get('NEMO_QWEN_OPTIMIZE')
    try:
        os.environ['NEMO_QWEN_OPTIMIZE'] = '1'
        c = _conn(model='qwen3.5-9b', parallel=True)
        assert qwen_optimize_profile_active(c)
        assert not effective_parallel_tool_calls(c)
    finally:
        if prev is None:
            os.environ.pop('NEMO_QWEN_OPTIMIZE', None)
        else:
            os.environ['NEMO_QWEN_OPTIMIZE'] = prev


def test_parallel_respects_connection_when_qwen_optimize_off() -> None:
    prev = os.environ.get('NEMO_QWEN_OPTIMIZE')
    try:
        os.environ['NEMO_QWEN_OPTIMIZE'] = '0'
        c = _conn(model='qwen3.5-9b', parallel=True)
        assert not qwen_optimize_profile_active(c)
        assert effective_parallel_tool_calls(c)
    finally:
        if prev is None:
            os.environ.pop('NEMO_QWEN_OPTIMIZE', None)
        else:
            os.environ['NEMO_QWEN_OPTIMIZE'] = prev


def test_qwen_preset_without_qwen_model_id() -> None:
    c = _conn(model='local-model', parallel=True, optimization_preset='qwen')
    assert qwen_optimize_profile_active(c)
    assert not effective_parallel_tool_calls(c)


def test_connection_max_output_tokens_override() -> None:
    prev_global = os.environ.get('NEMO_CHAT_MAX_OUTPUT_TOKENS')
    try:
        os.environ.pop('NEMO_CHAT_MAX_OUTPUT_TOKENS', None)
        c = _conn(model='gpt-4', parallel=True, optimization_preset='generic', max_output_tokens=2048)
        assert llm_optional_kwargs(c) == {'max_tokens': 2048}
    finally:
        if prev_global is None:
            os.environ.pop('NEMO_CHAT_MAX_OUTPUT_TOKENS', None)
        else:
            os.environ['NEMO_CHAT_MAX_OUTPUT_TOKENS'] = prev_global


def test_combined_suffix_includes_universal_tool_rules_for_non_qwen() -> None:
    c = _conn(model='gpt-4o', parallel=False, optimization_preset='generic')
    s = combined_model_prompt_suffix(c)
    assert 'Direct workspace edit tools' in s
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
    assert 'Direct workspace edit tools' in s


def test_qwen_system_prompt_suffix_backward_compat() -> None:
    s = qwen_system_prompt_suffix()
    assert 'Direct workspace edit tools' in s
    assert 'Model note (Qwen)' in s


def test_llm_optional_max_tokens_for_qwen() -> None:
    prev_opt = os.environ.get('NEMO_QWEN_OPTIMIZE')
    prev_global = os.environ.get('NEMO_CHAT_MAX_OUTPUT_TOKENS')
    prev_qwen = os.environ.get('NEMO_QWEN_DEFAULT_MAX_OUTPUT_TOKENS')
    try:
        os.environ.pop('NEMO_CHAT_MAX_OUTPUT_TOKENS', None)
        os.environ['NEMO_QWEN_OPTIMIZE'] = '1'
        os.environ['NEMO_QWEN_DEFAULT_MAX_OUTPUT_TOKENS'] = '4096'
        c = _conn(model='Qwen3.5-9B-Instruct')
        assert llm_optional_kwargs(c) == {'max_tokens': 4096}
    finally:
        for key, val in (
            ('NEMO_QWEN_OPTIMIZE', prev_opt),
            ('NEMO_CHAT_MAX_OUTPUT_TOKENS', prev_global),
            ('NEMO_QWEN_DEFAULT_MAX_OUTPUT_TOKENS', prev_qwen),
        ):
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
