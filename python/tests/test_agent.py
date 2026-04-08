"""Unit tests for agent stream persistence behavior."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from nemo_backend import state
from nemo_backend.agent import stream_agent_reply
from nemo_backend.domain import SessionState


@pytest.mark.asyncio
@patch('nemo_backend.agent.build_llm')
@patch('nemo_backend.agent.stream_single_agent_langgraph')
async def test_stream_agent_reply_does_not_persist_aborted_partial_text(
    mock_stream_single_agent_langgraph: MagicMock,
    mock_build_llm: MagicMock,
) -> None:
    session_id = 'test-abort-persists-history'
    state.sessions[session_id] = SessionState()
    mock_build_llm.return_value = MagicMock()

    async def _fake_stream(session: SessionState, *_args, **kwargs):
        outcome = kwargs['outcome']
        outcome.partial_text = 'Partial assistant reply'
        session.abort_event.set()
        yield 'data: {"type":"chunk","delta":"Partial assistant reply"}\n\n'

    mock_stream_single_agent_langgraph.side_effect = _fake_stream

    try:
        lines = [line async for line in stream_agent_reply(session_id, 'hello')]
        session = state.get_session(session_id)

        assert lines == ['data: [DONE]\n\n']
        assert session.history == []
    finally:
        state.sessions.pop(session_id, None)
