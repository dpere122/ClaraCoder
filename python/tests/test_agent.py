"""Unit tests for agent stream persistence behavior."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from clara_coder_backend import state
from clara_coder_backend.agent import stream_agent_reply
from clara_coder_backend.context_compression import CompactResult
from clara_coder_backend.domain import SessionState


@pytest.mark.asyncio
@patch('clara_coder_backend.agent.build_llm')
@patch('clara_coder_backend.agent.stream_single_agent_langgraph')
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


@pytest.mark.asyncio
@patch('clara_coder_backend.agent.maybe_compact_outer_checkpoint', new_callable=AsyncMock)
@patch('clara_coder_backend.agent.build_llm')
@patch('clara_coder_backend.agent.stream_single_agent_langgraph')
async def test_stream_agent_reply_emits_context_compressed_after_compaction(
    mock_stream_single_agent_langgraph: MagicMock,
    mock_build_llm: MagicMock,
    mock_compact: AsyncMock,
) -> None:
    session_id = 'test-context-compact-sse'
    state.sessions[session_id] = SessionState()
    mock_build_llm.return_value = MagicMock()

    async def _fake_stream(session: SessionState, *_args, **kwargs):
        outcome = kwargs['outcome']
        outcome.mark_completed(final_text='Done.', partial_text='Done.')
        yield 'data: {"type":"chunk","delta":"Done."}\n\n'

    mock_stream_single_agent_langgraph.side_effect = _fake_stream
    mock_compact.return_value = CompactResult(
        ran=True,
        changed=True,
        tokens_before=12_000,
        tokens_after=6_000,
        tool_messages_compacted=3,
        tool_rounds_dropped=0,
    )

    try:
        lines = [line async for line in stream_agent_reply(session_id, 'hello')]
        session = state.get_session(session_id)

        mock_compact.assert_awaited_once_with(session_id, True, session)
        compact_lines = [line for line in lines if 'context_compressed' in line]
        assert len(compact_lines) == 1
        payload = json.loads(compact_lines[0].removeprefix('data: ').strip())
        assert payload['type'] == 'context_compressed'
        assert payload['tokens_before'] == 12_000
        assert payload['tokens_after'] == 6_000
        assert payload['tool_messages_compacted'] == 3
    finally:
        state.sessions.pop(session_id, None)


@pytest.mark.asyncio
@patch('clara_coder_backend.agent.maybe_compact_outer_checkpoint', new_callable=AsyncMock)
@patch('clara_coder_backend.agent.build_llm')
@patch('clara_coder_backend.agent.stream_single_agent_langgraph')
async def test_stream_agent_reply_skips_compaction_when_not_completed(
    mock_stream_single_agent_langgraph: MagicMock,
    mock_build_llm: MagicMock,
    mock_compact: AsyncMock,
) -> None:
    session_id = 'test-context-compact-skip'
    state.sessions[session_id] = SessionState()
    mock_build_llm.return_value = MagicMock()

    async def _fake_stream(session: SessionState, *_args, **kwargs):
        outcome = kwargs['outcome']
        outcome.mark_aborted(partial_text='Partial')
        yield 'data: {"type":"chunk","delta":"Partial"}\n\n'

    mock_stream_single_agent_langgraph.side_effect = _fake_stream

    try:
        lines = [line async for line in stream_agent_reply(session_id, 'hello')]
        mock_compact.assert_not_awaited()
        assert not any('context_compressed' in line for line in lines)
    finally:
        state.sessions.pop(session_id, None)
