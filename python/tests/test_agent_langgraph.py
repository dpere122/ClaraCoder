from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from clara_coder_backend.lang_agent.graph import (
    _stream_is_genuinely_stalled,
    stream_single_agent_langgraph,
)
from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent.langgraph_sse import GraphStreamState

pytestmark = pytest.mark.asyncio(loop_scope='function')


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


async def test_stream_is_genuinely_stalled_true_when_idle() -> None:
    assert _stream_is_genuinely_stalled(SessionState(), GraphStreamState()) is True


async def test_stream_is_genuinely_stalled_false_while_tool_running() -> None:
    state = GraphStreamState()
    state.pending_tool_runs['r1'] = ('delete_workspace_entry', {})
    assert _stream_is_genuinely_stalled(SessionState(), state) is False


async def test_stream_is_genuinely_stalled_false_during_hitl_pause() -> None:
    session = SessionState()
    session.agent_pause_event = asyncio.Event()
    assert _stream_is_genuinely_stalled(session, GraphStreamState()) is False


async def test_stream_is_genuinely_stalled_false_with_pending_delete_request() -> None:
    session = SessionState()
    session.pending_delete_request = {'request_id': 'x'}
    assert _stream_is_genuinely_stalled(session, GraphStreamState()) is False


async def test_hitl_pause_lock_serializes_concurrent_waiters() -> None:
    from clara_coder_backend.session.pause import await_diff_review_note
    from clara_coder_backend.session.state import current_session_id, get_session, sessions

    sid = 'hitl-pause-lock-test'
    sessions.pop(sid, None)
    token = current_session_id.set(sid)
    sess = get_session(sid)
    finished: list[str] = []

    async def waiter(tag: str) -> None:
        await await_diff_review_note(sid)
        finished.append(tag)

    try:
        first = asyncio.create_task(waiter('a'))
        await asyncio.sleep(0.02)
        second = asyncio.create_task(waiter('b'))
        await asyncio.sleep(0.02)
        pause = sess.agent_pause_event
        assert pause is not None
        pause.set()
        await first
        await asyncio.sleep(0.02)
        pause2 = sess.agent_pause_event
        assert pause2 is not None
        assert pause2 is not pause
        pause2.set()
        await second
        assert finished == ['a', 'b']
    finally:
        current_session_id.reset(token)
        sessions.pop(sid, None)


@patch('clara_coder_backend.lang_agent.graph.build_clara_single_outer_graph')
@patch('clara_coder_backend.lang_agent.graph.build_llm')
@patch('clara_coder_backend.lang_agent.graph.get_graph_checkpointer')
async def test_stream_single_agent_langgraph_aborts_while_waiting_for_events(
    mock_get_cp: MagicMock,
    mock_build_llm: MagicMock,
    mock_build_graph: MagicMock,
) -> None:
    mock_get_cp.return_value = MagicMock()
    mock_build_llm.return_value = MagicMock()

    async def _hung_stream(*_args: Any, **_kwargs: Any):
        await asyncio.Future()
        yield {'event': 'on_chain_end', 'data': {}}

    mock_graph = MagicMock()
    mock_graph.astream_events = _hung_stream
    mock_graph.aget_state = AsyncMock(return_value=MagicMock(values={}))
    mock_build_graph.return_value = mock_graph

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    task = asyncio.create_task(
        _collect_lines(
            stream_single_agent_langgraph(
                session,
                'hello',
                True,
                session_id='sess-1',
                outcome=outcome,
            )
        )
    )
    await asyncio.sleep(0)

    session.abort_event.set()
    lines = await asyncio.wait_for(task, timeout=1)

    assert lines == []
    assert outcome.state == AgentLoopOutcome.ABORTED


@patch('clara_coder_backend.lang_agent.graph.build_clara_single_outer_graph')
@patch('clara_coder_backend.lang_agent.graph.build_llm')
@patch('clara_coder_backend.lang_agent.graph.get_graph_checkpointer')
async def test_stream_single_agent_langgraph_allocates_nested_events_queue(
    mock_get_cp: MagicMock,
    mock_build_llm: MagicMock,
    mock_build_graph: MagicMock,
) -> None:
    """Outer chat stream must set planning_nested_events_q so tool_exec_* tools can stream."""
    mock_get_cp.return_value = MagicMock()
    mock_build_llm.return_value = MagicMock()

    async def _hung_stream(*_args: Any, **_kwargs: Any):
        await asyncio.Future()
        yield {'event': 'on_chain_end', 'data': {}}

    mock_graph = MagicMock()
    mock_graph.astream_events = _hung_stream
    mock_graph.aget_state = AsyncMock(return_value=MagicMock(values={}))
    mock_build_graph.return_value = mock_graph

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    task = asyncio.create_task(
        _collect_lines(
            stream_single_agent_langgraph(
                session,
                'hello',
                True,
                session_id='sess-1',
                outcome=outcome,
            )
        )
    )
    await asyncio.sleep(0)

    assert session.planning_nested_events_q is not None

    session.abort_event.set()
    await asyncio.wait_for(task, timeout=1)

    assert outcome.state == AgentLoopOutcome.ABORTED


@patch('clara_coder_backend.lang_agent.graph._stream_watchdog_timeout_sec', return_value=0.05)
@patch('clara_coder_backend.lang_agent.graph.build_clara_single_outer_graph')
@patch('clara_coder_backend.lang_agent.graph.build_llm')
@patch('clara_coder_backend.lang_agent.graph.get_graph_checkpointer')
async def test_stream_watchdog_ends_stalled_stream(
    mock_get_cp: MagicMock,
    mock_build_llm: MagicMock,
    mock_build_graph: MagicMock,
    _mock_wd: MagicMock,
) -> None:
    """A hung model call with no active tool/HITL must end via the watchdog, not hang forever."""
    mock_get_cp.return_value = MagicMock()
    mock_build_llm.return_value = MagicMock()

    async def _hung_stream(*_args: Any, **_kwargs: Any):
        await asyncio.Future()
        yield {'event': 'on_chain_end', 'data': {}}

    mock_graph = MagicMock()
    mock_graph.astream_events = _hung_stream
    mock_graph.aget_state = AsyncMock(return_value=MagicMock(values={}))
    mock_build_graph.return_value = mock_graph

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    lines = await asyncio.wait_for(
        _collect_lines(
            stream_single_agent_langgraph(
                session,
                'hello',
                True,
                session_id='sess-wd',
                outcome=outcome,
            )
        ),
        timeout=2,
    )

    assert outcome.state == AgentLoopOutcome.FAILED_RUNTIME
    assert any('error' in line for line in lines)


@patch('clara_coder_backend.lang_agent.graph._stream_watchdog_timeout_sec', return_value=0.05)
@patch('clara_coder_backend.lang_agent.graph.build_clara_single_outer_graph')
@patch('clara_coder_backend.lang_agent.graph.build_llm')
@patch('clara_coder_backend.lang_agent.graph.get_graph_checkpointer')
async def test_stream_watchdog_does_not_fire_while_tool_running(
    mock_get_cp: MagicMock,
    mock_build_llm: MagicMock,
    mock_build_graph: MagicMock,
    _mock_wd: MagicMock,
) -> None:
    """A long-running tool (on_tool_start, no on_tool_end yet) must not trip the watchdog."""
    mock_get_cp.return_value = MagicMock()
    mock_build_llm.return_value = MagicMock()

    async def _tool_then_hang(*_args: Any, **_kwargs: Any):
        yield {
            'event': 'on_tool_start',
            'name': 'run_command',
            'run_id': 'tool-run-1',
            'data': {'input': {}},
        }
        await asyncio.Future()

    mock_graph = MagicMock()
    mock_graph.astream_events = _tool_then_hang
    mock_graph.aget_state = AsyncMock(return_value=MagicMock(values={}))
    mock_build_graph.return_value = mock_graph

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    task = asyncio.create_task(
        _collect_lines(
            stream_single_agent_langgraph(
                session,
                'hello',
                True,
                session_id='sess-wd-tool',
                outcome=outcome,
            )
        )
    )
    # Let the tool-start event process and several watchdog intervals elapse.
    await asyncio.sleep(0.3)
    assert outcome.state == AgentLoopOutcome.RUNNING

    session.abort_event.set()
    await asyncio.wait_for(task, timeout=2)
    assert outcome.state == AgentLoopOutcome.ABORTED


async def _forever() -> None:
    await asyncio.Future()


async def test_stop_llm_pump_cancels_the_pump_even_when_closing_the_response_is_cancelled() -> None:
    """A cancellation landing on the HTTP close must not leave ``astream_events`` running."""
    from clara_coder_backend.lang_agent.graph import _stop_llm_pump

    pump = asyncio.create_task(_forever())
    await asyncio.sleep(0)

    async def _cancelled_close(_sid: str) -> None:
        raise asyncio.CancelledError

    with patch('clara_coder_backend.lang_agent.graph.abort_in_flight_llm_requests', side_effect=_cancelled_close):
        with pytest.raises(asyncio.CancelledError):
            await _stop_llm_pump(pump, 'sess-stop')
    assert pump.cancelled()


async def test_stop_llm_pump_closes_the_response_after_cancelling() -> None:
    from clara_coder_backend.lang_agent.graph import _stop_llm_pump

    order: list[str] = []
    pump = asyncio.create_task(_forever())
    await asyncio.sleep(0)
    cancel = pump.cancel

    def _recording_cancel(*args: Any, **kwargs: Any) -> bool:
        order.append('cancel pump')
        return cancel(*args, **kwargs)

    pump.cancel = _recording_cancel  # type: ignore[method-assign]

    async def _close(_sid: str) -> None:
        order.append('close response')

    with patch('clara_coder_backend.lang_agent.graph.abort_in_flight_llm_requests', side_effect=_close):
        await _stop_llm_pump(pump, 'sess-stop')
    assert order == ['cancel pump', 'close response'] and pump.cancelled()


@patch('clara_coder_backend.lang_agent.graph.build_clara_single_outer_graph')
@patch('clara_coder_backend.lang_agent.graph.build_llm')
@patch('clara_coder_backend.lang_agent.graph.get_graph_checkpointer')
async def test_abort_mid_step_reports_uncommitted_text_and_uses_sync_durability(
    mock_get_cp: MagicMock,
    mock_build_llm: MagicMock,
    mock_build_graph: MagicMock,
) -> None:
    from langchain_core.messages import AIMessageChunk

    mock_get_cp.return_value = MagicMock()
    mock_build_llm.return_value = MagicMock()
    seen_kwargs: dict[str, Any] = {}

    async def _stream_then_hang(*_args: Any, **kwargs: Any):
        seen_kwargs.update(kwargs)
        yield {'event': 'on_chat_model_start', 'name': 'm', 'run_id': 'm1', 'data': {'input': {}}}
        yield {'event': 'on_chat_model_stream', 'name': 'm', 'run_id': 'm1', 'data': {'chunk': AIMessageChunk(content='half a ')}}
        yield {'event': 'on_chat_model_stream', 'name': 'm', 'run_id': 'm1', 'data': {'chunk': AIMessageChunk(content='sentence')}}
        await asyncio.Future()

    mock_graph = MagicMock()
    mock_graph.astream_events = _stream_then_hang
    mock_graph.aget_state = AsyncMock(return_value=MagicMock(values={}))
    mock_build_graph.return_value = mock_graph

    session = SessionState()
    outcome = LangGraphWorkerOutcome()
    task = asyncio.create_task(
        _collect_lines(stream_single_agent_langgraph(session, 'hello', True, session_id='sess-mid', outcome=outcome))
    )
    for _ in range(50):
        if outcome.partial_text == 'half a sentence':
            break
        await asyncio.sleep(0.01)
    session.abort_event.set()
    await asyncio.wait_for(task, timeout=2)

    assert outcome.state == AgentLoopOutcome.ABORTED
    assert outcome.uncommitted_text == 'half a sentence'
    assert seen_kwargs.get('durability') == 'sync'
    # The live chat turn binds ``spawn_subagent``.
    assert mock_build_graph.call_args.kwargs.get('allow_subagents') is True


@patch('clara_coder_backend.lang_agent.graph.build_clara_single_outer_graph')
@patch('clara_coder_backend.lang_agent.graph.build_llm')
@patch('clara_coder_backend.lang_agent.graph.get_graph_checkpointer')
async def test_open_tool_calls_of_a_stopped_turn_are_answered_before_the_new_input(
    mock_get_cp: MagicMock,
    mock_build_llm: MagicMock,
    mock_build_graph: MagicMock,
) -> None:
    from types import SimpleNamespace

    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    stopped_step = AIMessage(content='', tool_calls=[{'name': 'spawn_subagent', 'args': {}, 'id': 's1'}])
    saved = SimpleNamespace(
        checkpoint={'channel_values': {'messages': [HumanMessage('before'), stopped_step]}},
        pending_writes=[],
    )
    mock_get_cp.return_value = MagicMock(aget_tuple=AsyncMock(return_value=saved))
    mock_build_llm.return_value = MagicMock()
    seen_inputs: list[Any] = []

    async def _done(inputs: Any, *_args: Any, **_kwargs: Any):
        seen_inputs.append(inputs)
        if False:
            yield {}

    mock_graph = MagicMock()
    mock_graph.astream_events = _done
    mock_graph.aget_state = AsyncMock(return_value=MagicMock(values={'messages': [HumanMessage('before'), stopped_step]}))
    mock_build_graph.return_value = mock_graph

    session = SessionState()
    session.subagent_interrupted_reports['s1'] = 'Sub-agent `x` was stopped; partial report.'
    session.pending_user_event_notes.append('Your previous reply was interrupted.')
    outcome = LangGraphWorkerOutcome()
    await _collect_lines(stream_single_agent_langgraph(session, 'again', True, session_id='sess-repair', outcome=outcome))

    messages = seen_inputs[0]['messages']
    assert isinstance(messages[0], ToolMessage) and messages[0].tool_call_id == 's1'
    assert messages[0].content == 'Sub-agent `x` was stopped; partial report.'
    assert [type(m).__name__ for m in messages[1:]] == ['HumanMessage', 'HumanMessage']
    assert 'interrupted' in messages[1].content and 'again' in messages[2].content
    assert session.subagent_interrupted_reports == {}
