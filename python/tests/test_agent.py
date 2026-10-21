"""Unit tests for agent stream persistence behavior."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from clara_coder_backend.session import state
from clara_coder_backend.composer import stream_agent_reply
from clara_coder_backend.lang_agent.context_compression import CompactResult
from clara_coder_backend.domain import SessionState


@pytest.mark.asyncio
@patch('clara_coder_backend.composer.delete_outer_thread', new_callable=AsyncMock)
@patch('clara_coder_backend.composer.build_llm')
@patch('clara_coder_backend.composer.stream_single_agent_langgraph')
async def test_stream_agent_reply_keeps_an_aborted_agent_turn_as_interrupted(
    mock_stream_single_agent_langgraph: MagicMock,
    mock_build_llm: MagicMock,
    mock_delete_thread: AsyncMock,
) -> None:
    session_id = 'test-abort-persists-history'
    state.sessions[session_id] = SessionState()
    state.sessions[session_id].pending_accept_command_request = {'request_id': 'stale'}
    mock_build_llm.return_value = MagicMock()

    async def _fake_stream(session: SessionState, *_args, **kwargs):
        outcome = kwargs['outcome']
        outcome.partial_text = 'Partial assistant reply'
        outcome.uncommitted_text = 'Partial assistant reply'
        session.abort_event.set()
        yield 'data: {"type":"chunk","delta":"Partial assistant reply"}\n\n'

    mock_stream_single_agent_langgraph.side_effect = _fake_stream

    try:
        lines = [line async for line in stream_agent_reply(session_id, 'hello')]
        session = state.get_session(session_id)

        assert lines == ['data: [DONE]\n\n']
        # The checkpoint stays (the next turn repairs it); history keeps the partial reply with a marker.
        mock_delete_thread.assert_not_awaited()
        assert session.history == [
            {'role': 'user', 'content': 'hello'},
            {'role': 'assistant', 'content': 'Partial assistant reply\n\n[Interrupted by the user]'},
        ]
        [note] = session.pending_user_event_notes
        assert 'interrupted by the user' in note and '"hello"' in note
        assert 'Partial assistant reply' in note and 'remain' in note
        assert session.pending_accept_command_request is None
    finally:
        state.sessions.pop(session_id, None)


@pytest.mark.asyncio
@patch('clara_coder_backend.composer.delete_outer_thread', new_callable=AsyncMock)
@patch('clara_coder_backend.composer.build_llm')
@patch('clara_coder_backend.composer.stream_plan_execute_langgraph')
async def test_stream_agent_reply_still_drops_an_aborted_plan_turn(
    mock_stream_plan: MagicMock,
    mock_build_llm: MagicMock,
    mock_delete_thread: AsyncMock,
) -> None:
    session_id = 'test-abort-plan'
    state.sessions[session_id] = SessionState()
    mock_build_llm.return_value = MagicMock()

    async def _fake_stream(session: SessionState, *_args, **kwargs):
        kwargs['outcome'].mark_aborted(partial_text='Partial')
        yield 'data: {"type":"chunk","delta":"Partial"}\n\n'

    mock_stream_plan.side_effect = _fake_stream
    try:
        _ = [line async for line in stream_agent_reply(session_id, 'hello', composer_mode='plan')]
        mock_delete_thread.assert_awaited_once()
        assert state.sessions[session_id].history == []
        assert state.sessions[session_id].pending_user_event_notes == []
    finally:
        state.sessions.pop(session_id, None)


@pytest.mark.asyncio
@patch('clara_coder_backend.composer.build_llm')
@patch('clara_coder_backend.composer.stream_single_agent_langgraph')
async def test_stream_agent_reply_closes_the_runner_before_post_stream_chores(
    mock_stream_single_agent_langgraph: MagicMock,
    mock_build_llm: MagicMock,
) -> None:
    """Breaking out on abort must run the runner's cleanup now, not later from asyncgen hooks."""
    session_id = 'test-abort-aclosing'
    state.sessions[session_id] = SessionState()
    mock_build_llm.return_value = MagicMock()
    order: list[str] = []

    async def _fake_stream(session: SessionState, *_args, **kwargs):
        try:
            yield 'data: {"type":"chunk","delta":"a"}\n\n'
            session.abort_event.set()
            yield 'data: {"type":"chunk","delta":"b"}\n\n'
            yield 'data: {"type":"chunk","delta":"never"}\n\n'
        finally:
            order.append('runner cleanup')

    mock_stream_single_agent_langgraph.side_effect = _fake_stream

    def _note(*_args, **_kwargs) -> None:
        order.append('post-stream')

    try:
        with patch('clara_coder_backend.composer.queue_interrupted_turn_note', side_effect=_note):
            lines = [line async for line in stream_agent_reply(session_id, 'hello')]
        assert order == ['runner cleanup', 'post-stream']
        assert lines == ['data: {"type":"chunk","delta":"a"}\n\n', 'data: [DONE]\n\n']
    finally:
        state.sessions.pop(session_id, None)


@pytest.mark.asyncio
@patch('clara_coder_backend.composer.build_llm')
@patch('clara_coder_backend.composer.stream_single_agent_langgraph')
async def test_outcome_sink_is_filled_on_every_exit_path(
    mock_stream_single_agent_langgraph: MagicMock,
    mock_build_llm: MagicMock,
) -> None:
    from fastapi import HTTPException

    from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome

    session_id = 'test-outcome-sink'
    state.sessions[session_id] = SessionState()
    try:
        # Configuration error before any graph runs.
        mock_build_llm.side_effect = HTTPException(status_code=500, detail='No API key.')
        sink = LangGraphWorkerOutcome()
        _ = [line async for line in stream_agent_reply(session_id, 'hi', outcome_sink=sink)]
        assert sink.state == AgentLoopOutcome.FAILED_CONFIGURATION and 'No API key.' in sink.final_text

        # Completed run.
        mock_build_llm.side_effect = None
        mock_build_llm.return_value = MagicMock()

        async def _done(session: SessionState, *_args, **kwargs):
            kwargs['outcome'].mark_completed(final_text='Report.', partial_text='Report.')
            yield 'data: {"type":"chunk","delta":"Report."}\n\n'

        mock_stream_single_agent_langgraph.side_effect = _done
        sink = LangGraphWorkerOutcome()
        with patch('clara_coder_backend.composer.maybe_compact_outer_checkpoint', new_callable=AsyncMock, return_value=None):
            _ = [line async for line in stream_agent_reply(session_id, 'hi', outcome_sink=sink)]
        assert sink.state == AgentLoopOutcome.COMPLETED and sink.final_text == 'Report.'

        # Unexpected exception from the runner.
        async def _boom(session: SessionState, *_args, **kwargs):
            kwargs['outcome'].partial_text = 'half'
            yield 'data: {"type":"chunk","delta":"half"}\n\n'
            raise RuntimeError('kaput')

        mock_stream_single_agent_langgraph.side_effect = _boom
        sink = LangGraphWorkerOutcome()
        _ = [line async for line in stream_agent_reply(session_id, 'hi', outcome_sink=sink)]
        assert sink.state == AgentLoopOutcome.FAILED_RUNTIME
        assert 'kaput' in sink.error_detail and sink.partial_text == 'half'

        # The consumer stops reading early: the outcome is settled as aborted, not left running.
        async def _endless(session: SessionState, *_args, **kwargs):
            while True:
                yield 'data: {"type":"chunk","delta":"x"}\n\n'

        mock_stream_single_agent_langgraph.side_effect = _endless
        sink = LangGraphWorkerOutcome()
        gen = stream_agent_reply(session_id, 'hi', outcome_sink=sink)
        await gen.__anext__()
        await gen.aclose()
        assert sink.state == AgentLoopOutcome.ABORTED
    finally:
        state.sessions.pop(session_id, None)


@pytest.mark.asyncio
@patch('clara_coder_backend.composer.maybe_compact_outer_checkpoint', new_callable=AsyncMock)
@patch('clara_coder_backend.composer.build_llm')
@patch('clara_coder_backend.composer.stream_single_agent_langgraph')
async def test_subagent_turns_skip_compaction_and_history(
    mock_stream_single_agent_langgraph: MagicMock,
    mock_build_llm: MagicMock,
    mock_compact: AsyncMock,
) -> None:
    session_id = 'test-subagent-turn'
    child = SessionState()
    child.subagent_parent_session_id = 'parent-x'
    state.sessions[session_id] = child
    mock_build_llm.return_value = MagicMock()

    async def _done(session: SessionState, *_args, **kwargs):
        kwargs['outcome'].mark_completed(final_text='Report.', partial_text='Report.')
        yield 'data: {"type":"chunk","delta":"Report."}\n\n'

    mock_stream_single_agent_langgraph.side_effect = _done
    try:
        lines = [line async for line in stream_agent_reply(session_id, 'task')]
        mock_compact.assert_not_awaited()
        assert child.history == []
        assert any('final_text' in line for line in lines) and lines[-1] == 'data: [DONE]\n\n'
    finally:
        state.sessions.pop(session_id, None)


@pytest.mark.asyncio
@patch('clara_coder_backend.composer.maybe_compact_outer_checkpoint', new_callable=AsyncMock)
@patch('clara_coder_backend.composer.build_llm')
@patch('clara_coder_backend.composer.stream_single_agent_langgraph')
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
@patch('clara_coder_backend.composer.maybe_compact_outer_checkpoint', new_callable=AsyncMock)
@patch('clara_coder_backend.composer.build_llm')
@patch('clara_coder_backend.composer.stream_single_agent_langgraph')
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
