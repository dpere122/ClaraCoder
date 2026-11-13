"""A conversation's own thinking settings apply to its turns only (the composer keeps them per conversation)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

from clara_coder_backend.composer import conversation_connection, stream_agent_reply
from clara_coder_backend.domain import RuntimeConnection, SessionState
from clara_coder_backend.session import state
from clara_coder_backend.session.schemas import ChatRequest


@pytest.fixture()
def main_source():
    """One active source with thinking on and a high reasoning level, restored afterwards."""
    cfg = state.runtime_config
    saved = (cfg.connections, cfg.active_connection_id)
    cfg.connections = [
        RuntimeConnection(
            id='main',
            provider='openai',
            name='main',
            base_url='https://api.example.com/v1',
            model='main-model',
            thinking_mode='on',
            reasoning_effort='high',
        )
    ]
    cfg.active_connection_id = 'main'
    yield cfg.connections[0]
    cfg.connections, cfg.active_connection_id = saved


def test_chat_request_takes_the_conversations_thinking() -> None:
    body = ChatRequest.model_validate({'session_id': 's', 'message': 'hi', 'thinkingMode': 'off', 'reasoningEffort': ''})
    assert (body.thinking_mode, body.reasoning_effort) == ('off', '')
    plain = ChatRequest.model_validate({'session_id': 's', 'message': 'hi'})
    assert (plain.thinking_mode, plain.reasoning_effort) == (None, None)
    with pytest.raises(ValidationError):
        ChatRequest.model_validate({'session_id': 's', 'message': 'hi', 'thinking_mode': 'max'})


def test_no_settings_or_the_sources_own_change_nothing(main_source: RuntimeConnection) -> None:
    assert conversation_connection(None, None) is None
    assert conversation_connection('on', 'high') is None


def test_the_conversations_settings_replace_the_sources_on_a_copy(main_source: RuntimeConnection) -> None:
    pinned = conversation_connection('off', 'LOW')
    assert pinned is not None
    assert (pinned.id, pinned.model) == ('main', 'main-model')
    assert (pinned.thinking_mode, pinned.reasoning_effort) == ('off', 'low')
    # Settings are untouched: another conversation's turn still gets the source's own.
    assert (main_source.thinking_mode, main_source.reasoning_effort) == ('on', 'high')
    # Only the field the conversation set changes.
    only_level = conversation_connection(None, '')
    assert only_level is not None
    assert (only_level.thinking_mode, only_level.reasoning_effort) == ('on', '')


@pytest.mark.asyncio
@patch('clara_coder_backend.composer.delete_outer_thread', new_callable=AsyncMock)
@patch('clara_coder_backend.composer.build_llm')
@patch('clara_coder_backend.composer.stream_single_agent_langgraph')
async def test_a_turn_runs_with_its_conversations_thinking_and_leaves_none_behind(
    mock_stream: MagicMock,
    mock_build_llm: MagicMock,
    _mock_delete_thread: AsyncMock,
    main_source: RuntimeConnection,
) -> None:
    session_id = 'conversation-thinking-turn'
    state.sessions[session_id] = SessionState()
    mock_build_llm.return_value = MagicMock()
    seen: list[RuntimeConnection] = []

    async def _fake_stream(session: SessionState, *_args: Any, **_kwargs: Any):
        seen.append(state.get_active_connection())
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_stream.side_effect = _fake_stream
    try:
        _ = [line async for line in stream_agent_reply(session_id, 'hello', thinking_mode='off', reasoning_effort='low')]
        _ = [line async for line in stream_agent_reply(session_id, 'again')]
    finally:
        state.sessions.pop(session_id, None)

    assert [(c.thinking_mode, c.reasoning_effort) for c in seen] == [('off', 'low'), ('on', 'high')]
    assert state.current_connection_override.get() is None
    assert state.get_active_connection() is main_source


def _claude() -> RuntimeConnection:
    return RuntimeConnection(
        id='claude',
        provider='anthropic',
        name='Claude',
        base_url='https://api.anthropic.com',
        model='claude-sonnet',
        reasoning_effort='medium',
    )


def test_a_conversation_on_another_model_runs_on_that_source(main_source: RuntimeConnection) -> None:
    state.runtime_config.connections.append(_claude())
    pinned = conversation_connection(None, None, 'claude', 'claude-opus')
    assert pinned is not None
    assert (pinned.id, pinned.provider, pinned.model) == ('claude', 'anthropic', 'claude-opus')
    # That source's own thinking, not the active one's.
    assert pinned.reasoning_effort == 'medium'
    # Its thinking settings apply on top.
    low = conversation_connection(None, 'low', 'claude', None)
    assert low is not None and (low.id, low.model, low.reasoning_effort) == ('claude', 'claude-sonnet', 'low')


def test_the_active_model_or_a_deleted_one_pins_nothing(main_source: RuntimeConnection) -> None:
    assert conversation_connection(None, None, 'main', None) is None
    # A source deleted since falls back to the active one; its model name does not carry over.
    assert conversation_connection(None, None, 'gone', 'claude-opus') is None
