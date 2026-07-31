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
            'name': 'run_workspace_pytest_tests',
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
