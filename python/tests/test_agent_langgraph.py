from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nemo_backend.agent_langgraph import stream_single_agent_langgraph
from nemo_backend.agent_loop import AgentLoopOutcome, LangGraphWorkerOutcome
from nemo_backend.domain import SessionState

pytestmark = pytest.mark.asyncio(loop_scope='function')


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


@patch('nemo_backend.agent_langgraph.build_nemo_single_outer_graph')
@patch('nemo_backend.agent_langgraph.build_llm')
@patch('nemo_backend.agent_langgraph.get_graph_checkpointer')
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
