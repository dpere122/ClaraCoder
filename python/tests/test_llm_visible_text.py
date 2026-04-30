"""Tests for Gemma-visible assistant text sanitization."""

from nemo_backend.domain import RuntimeConnection
from nemo_backend.llm_visible_text import (
    gemma_template_sanitize_active_connection,
    is_auxiliary_reasoning_placeholder_delta,
    is_placeholder_stream_delta,
    is_placeholder_thinking_noise,
    maybe_sanitize_gemma_visible_assistant_text,
    sanitize_gemma_visible_assistant_text,
    strip_assistant_channel_noise,
    strip_llm_control_markers,
)


def _conn(**kwargs: object) -> RuntimeConnection:
    return RuntimeConnection(
        id='t',
        name='t',
        provider='lmstudio',
        base_url='http://127.0.0.1:1234/v1',
        model=str(kwargs.get('model', 'local')),
        parallel_tool_calls=bool(kwargs.get('parallel_tool_calls', False)),
        optimization_preset=str(kwargs.get('optimization_preset', 'generic')),
        max_output_tokens=int(kwargs.get('max_output_tokens', 0) or 0),
        thinking_mode=str(kwargs.get('thinking_mode', 'default')),
        architecture_hint=str(kwargs.get('architecture_hint', 'auto')),
        sampling_preset=str(kwargs.get('sampling_preset', 'provider-default')),
        top_p=kwargs.get('top_p'),  # type: ignore[arg-type]
        top_k=kwargs.get('top_k'),  # type: ignore[arg-type]
    )


def test_gemma_template_sanitize_active_preset() -> None:
    assert gemma_template_sanitize_active_connection(_conn(optimization_preset='gemma', model='x')) is True


def test_gemma_template_sanitize_active_model_family() -> None:
    assert gemma_template_sanitize_active_connection(_conn(optimization_preset='generic', model='gemma-4-it')) is True


def test_strip_preserves_fenced_literals() -> None:
    src = 'intro <|strip|> ok\n```\nx = "<|keep|>"\n```\nout'
    got = strip_llm_control_markers(src)
    assert '<|keep|>' in got
    assert '<|strip|>' not in got


def test_maybe_sanitize_strips_channel_noise_for_all_models() -> None:
    raw = 'a <|x|> b'
    c = _conn(model='llama-3', optimization_preset='generic')
    assert maybe_sanitize_gemma_visible_assistant_text(raw, connection=c) == 'a  b'


def test_maybe_sanitize_strips_tool_xml_for_non_gemma() -> None:
    raw = 'hi <tool_call name="n">{}</tool_call> there'
    c = _conn(model='llama-3', optimization_preset='generic')
    assert maybe_sanitize_gemma_visible_assistant_text(raw, connection=c) == 'hi  there'


def test_strip_assistant_channel_noise_order() -> None:
    assert 'tool_call' not in strip_assistant_channel_noise('x <tool_call>a</tool_call> <|y|>')


def test_strip_assistant_channel_noise_gemma_channel_and_thinking_heading() -> None:
    raw = '<|channel> 思考过程:\n\n1.Step.\n\n(Self-Correction: x.)Answer.'
    assert strip_assistant_channel_noise(raw) == '1.Step.\n\nAnswer.'


def test_maybe_sanitize_for_gemma_preset() -> None:
    raw = 'a <|x|> b'
    c = _conn(model='llama-3', optimization_preset='gemma')
    assert maybe_sanitize_gemma_visible_assistant_text(raw, connection=c) == 'a  b'


def test_sanitize_collapses_blank_ladders() -> None:
    assert sanitize_gemma_visible_assistant_text('x\n\n\n\n\ny') == 'x\n\n\ny'


def test_placeholder_thinking_noise_long_run() -> None:
    junk = '?' * 40
    assert is_placeholder_thinking_noise(junk) is True


def test_placeholder_thinking_noise_normal_text() -> None:
    assert is_placeholder_thinking_noise('Explain recursion in plain language.') is False


def test_placeholder_thinking_noise_short_question_marks() -> None:
    assert is_placeholder_thinking_noise('???') is False


def test_placeholder_thinking_noise_slash_wall() -> None:
    assert is_placeholder_thinking_noise('/' * 40) is True


def test_placeholder_thinking_noise_url_like_not_noise() -> None:
    assert is_placeholder_thinking_noise('See https://example.com/foo/bar for details.') is False


def test_placeholder_stream_delta_slash_chunk() -> None:
    assert is_placeholder_stream_delta('/' * 12) is True


def test_placeholder_stream_delta_normal_chunk() -> None:
    assert is_placeholder_stream_delta('Hello world.') is False


def test_auxiliary_reasoning_placeholder_single_slash() -> None:
    assert is_auxiliary_reasoning_placeholder_delta('/') is True
    assert is_auxiliary_reasoning_placeholder_delta(' / \n / ') is True


def test_auxiliary_reasoning_placeholder_keeps_mixed_text() -> None:
    assert is_auxiliary_reasoning_placeholder_delta('a/b') is False
    assert is_auxiliary_reasoning_placeholder_delta('step / 2') is False
