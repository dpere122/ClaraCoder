from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nemo_backend.agents.planning.nested_middleware import PlanningNestedWorkerMiddleware
from nemo_backend.state import current_session_id, get_session
from nemo_backend.agents.planning.tool import EXECUTE_WORKSPACE_MUTATION_NAME, PLAN_AND_MODIFY_NAME


pytestmark = pytest.mark.asyncio(loop_scope='function')


@patch('nemo_backend.agents.planning.nested_middleware.get_active_connection')
@patch('nemo_backend.agents.planning.nested_middleware.prepare_new_planner_graph_session')
@patch('nemo_backend.agents.planning.nested_middleware.run_coding_planner_orchestrated_stream', new_callable=AsyncMock)
async def test_middleware_runs_single_coding_planner_stream(
    mock_run_planner: AsyncMock,
    mock_prepare_graph: MagicMock,
    mock_active_connection: MagicMock,
) -> None:
    mock_active_connection.return_value = MagicMock(plan_retry_attempts_count=1)
    middleware = PlanningNestedWorkerMiddleware(checkpointer=None)
    session_id = 'middleware-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = 'C:/workspace'
    session.worker_apply_mode = True
    session.planning_nested_events_q = asyncio.Queue()

    async def _run_planner(session_obj, sid, task_summary, nested_q, checkpointer):
        del nested_q, checkpointer
        assert session_obj is session
        assert sid == session_id
        assert task_summary == 'Initial task'
        if session.planning_nested_done_event is not None:
            session.planning_nested_done_event.set()
        return 'Planner completed in one graph.'

    mock_run_planner.side_effect = _run_planner
    mock_prepare_graph.return_value = 'graph-1'

    request = SimpleNamespace(
        tool_call={
            'name': PLAN_AND_MODIFY_NAME,
            'id': 'tool-1',
            'args': {'task_summary': 'Initial task'},
        }
    )

    async def _handler(_request):
        raise AssertionError('handler should not be called for plan_and_modify')

    try:
        result = await middleware.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    assert result.content == 'Planner completed in one graph.'
    assert mock_prepare_graph.call_count == 1
    assert mock_run_planner.await_count == 1


@patch('nemo_backend.agents.planning.nested_middleware.NEMO_CODING_PLANNER_ENABLED', True)
@patch('nemo_backend.agents.planning.nested_middleware.get_active_connection')
@patch('nemo_backend.agents.planning.nested_middleware.prepare_new_planner_graph_session')
@patch('nemo_backend.agents.planning.nested_middleware.run_coding_planner_orchestrated_stream', new_callable=AsyncMock)
async def test_middleware_returns_aborted_result_while_waiting_for_nested_done_signal(
    mock_run_planner: AsyncMock,
    _mock_prepare_graph: MagicMock,
    mock_active_connection: MagicMock,
) -> None:
    mock_active_connection.return_value = MagicMock(plan_retry_attempts_count=1)
    mock_run_planner.return_value = 'Planner finished, but the sentinel was not consumed yet.'

    middleware = PlanningNestedWorkerMiddleware(checkpointer=None)
    session_id = 'middleware-abort-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = 'C:/workspace'
    session.worker_apply_mode = True
    session.planning_nested_events_q = asyncio.Queue()

    request = SimpleNamespace(
        tool_call={
            'name': PLAN_AND_MODIFY_NAME,
            'id': 'tool-abort',
            'args': {'task_summary': 'Abort this run'},
        }
    )

    async def _handler(_request):
        raise AssertionError('handler should not be called for plan_and_modify')

    try:
        task = asyncio.create_task(middleware.awrap_tool_call(request, _handler))
        await asyncio.sleep(0)
        session.abort_event.set()
        result = await asyncio.wait_for(task, timeout=1)
    finally:
        current_session_id.reset(token)

    assert result.content == 'Aborted by user.'


@patch('nemo_backend.agents.planning.nested_middleware.NEMO_CODING_PLANNER_ENABLED', True)
@patch('nemo_backend.agents.planning.nested_middleware.get_active_connection')
@patch('nemo_backend.agents.planning.nested_middleware.prepare_new_planner_graph_session')
@patch('nemo_backend.agents.planning.nested_middleware.run_planning_nested_stream', new_callable=AsyncMock)
@patch('nemo_backend.agents.planning.nested_middleware.run_coding_planner_orchestrated_stream', new_callable=AsyncMock)
async def test_execute_workspace_mutation_skips_coding_planner_when_enabled(
    mock_run_planner: AsyncMock,
    mock_run_nested: AsyncMock,
    mock_prepare_graph: MagicMock,
    mock_active_connection: MagicMock,
) -> None:
    mock_active_connection.return_value = MagicMock(plan_retry_attempts_count=1)
    middleware = PlanningNestedWorkerMiddleware(checkpointer=None)
    session_id = 'direct-router-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.workspace_path = 'C:/workspace'
    session.worker_apply_mode = True
    session.planning_nested_events_q = asyncio.Queue()

    async def _run_nested(session_obj, sid, task_summary, nested_q, checkpointer):
        del nested_q, checkpointer
        assert session_obj is session
        assert sid == session_id
        assert task_summary == 'Direct router task'
        if session.planning_nested_done_event is not None:
            session.planning_nested_done_event.set()
        return 'Router-only done.'

    mock_run_nested.side_effect = _run_nested

    request = SimpleNamespace(
        tool_call={
            'name': EXECUTE_WORKSPACE_MUTATION_NAME,
            'id': 'tool-direct',
            'args': {'task_summary': 'Direct router task'},
        }
    )

    async def _handler(_request):
        raise AssertionError('handler should not be called for execute_workspace_mutation')

    try:
        result = await middleware.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    assert result.content == 'Router-only done.'
    assert mock_prepare_graph.call_count == 1
    assert mock_run_nested.await_count == 1
    assert mock_run_planner.await_count == 0
