"""Gemma channel parsing in message text helpers."""

from unittest.mock import MagicMock, patch

from langchain_core.messages import AIMessage

from clara_coder_backend.session.domain import RuntimeConnection
from clara_coder_backend.llm.messages import assistant_visible_answer, reasoning_sidecar_text


def _gemma_conn() -> RuntimeConnection:
    return RuntimeConnection(
        id='g',
        name='g',
        provider='llamacpp',
        base_url='http://127.0.0.1:8080/v1',
        model='google/gemma-4-12B-it',
        api_key='',
        reasoning_effort='',
        temperature=1.0,
        parallel_tool_calls=False,
        optimization_preset='gemma',
        max_output_tokens=0,
        plan_retry_attempts_count=2,
    )


@patch('clara_coder_backend.llm.messages.get_active_connection')
def test_assistant_visible_answer_strips_gemma_thought_channel(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_conn()
    msg = AIMessage(content="<|channel>thought\nhidden<channel|>visible")
    assert assistant_visible_answer(msg) == 'visible'


@patch('clara_coder_backend.llm.messages.get_active_connection')
def test_reasoning_sidecar_from_gemma_channel(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_conn()
    msg = AIMessage(content="<|channel>thought\nhidden<channel|>visible")
    assert reasoning_sidecar_text(msg) == 'hidden'
