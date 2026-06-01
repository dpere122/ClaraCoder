from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nemo_backend.agent_loop import AgentLoopOutcome, LangGraphWorkerOutcome
from nemo_backend.domain import SessionState
from nemo_backend.plan_discovery import (
    DiscoveryEvaluationModel,
    DiscoveryIntentModel,
    build_discovery_context_block,
    build_discovery_task_prompt,
)
from nemo_backend.plan_execute import (
    PlanModel,
    ReplanAct,
    _invoke_planner,
    stream_plan_execute_langgraph,
)
from nemo_backend.plan_step_verify import StepVerifyResult
from nemo_backend.tool_registry import planner_discovery_tools_and_map, worker_tools_and_map


def test_build_discovery_task_prompt_lists_actions() -> None:
    prompt = build_discovery_task_prompt(
        ['Search for plan_execute', 'Read plan_execute.py'],
        objective='Add discovery phase',
    )
    assert 'Add discovery phase' in prompt
    assert 'Search for plan_execute' in prompt
    assert 'read-only' in prompt.lower()


def test_build_discovery_context_block_is_read_only() -> None:
    session = SessionState()
    block = build_discovery_context_block(session)
    assert 'Editor mode is off' in block
    assert 'Available read-only discovery tools' in block
    tools, _ = planner_discovery_tools_and_map(session=session)
    read_only_tools, _ = worker_tools_and_map(False, session=session)
    assert {t.name for t in tools} == {t.name for t in read_only_tools}
    catalog_part = block.split('Available read-only discovery tools')[1]
    assert 'stage_create_file' not in catalog_part


def test_discovery_intent_model_defaults_empty() -> None:
    intent = DiscoveryIntentModel()
    assert intent.actions == []


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


def _approved_verifier() -> StepVerifyResult:
    return StepVerifyResult(approved=True, evidence='Step satisfied.')


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@patch('nemo_backend.plan_execute.invoke_discovery_evaluation')
@patch('nemo_backend.plan_execute.invoke_discovery_intent')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_runs_discovery_before_planner(
    mock_intent: AsyncMock,
    mock_eval: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
    mock_verify: AsyncMock,
) -> None:
    mock_intent.return_value = DiscoveryIntentModel(actions=['Search for auth middleware'])
    mock_eval.return_value = DiscoveryEvaluationModel(
        ready_to_plan=True,
        summary='Auth lives in middleware/auth.py',
    )
    mock_planner.return_value = PlanModel(steps=['Do work'])
    mock_replanner.return_value = ReplanAct(response='All done.', steps=[])
    mock_pause.return_value = None
    mock_verify.return_value = _approved_verifier()

    exec_calls: list[bool] = []

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        apply_mode = _args[1] if len(_args) > 1 else _kwargs.get('apply_mode')
        exec_calls.append(bool(apply_mode))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Found auth middleware.')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    lines = await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-discovery',
            outcome=outcome,
        )
    )

    assert mock_intent.called
    assert mock_eval.called
    assert mock_planner.called
    assert any('"phase": "discovery"' in line for line in lines)
    assert any('"phase": "planning"' in line for line in lines)
    assert exec_calls[0] is False
    assert exec_calls[-1] is True
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@patch('nemo_backend.plan_execute.invoke_discovery_evaluation')
@patch('nemo_backend.plan_execute.invoke_discovery_intent')
@pytest.mark.asyncio(loop_scope='function')
async def test_discovery_loops_when_eval_not_ready(
    mock_intent: AsyncMock,
    mock_eval: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
    mock_verify: AsyncMock,
) -> None:
    mock_intent.return_value = DiscoveryIntentModel(actions=['Initial search'])
    mock_eval.side_effect = [
        DiscoveryEvaluationModel(
            ready_to_plan=False,
            summary='Partial: saw routes only.',
            additional_actions=['Read middleware/auth.py'],
        ),
        DiscoveryEvaluationModel(
            ready_to_plan=True,
            summary='Auth middleware confirmed.',
        ),
    ]
    mock_planner.return_value = PlanModel(steps=['Do work'])
    mock_replanner.return_value = ReplanAct(response='Done.', steps=[])
    mock_pause.return_value = None
    mock_verify.return_value = _approved_verifier()

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Discovery done.')
        yield 'data: {"type":"chunk"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-discovery-loop',
            outcome=outcome,
        )
    )

    assert mock_intent.call_count == 1
    assert mock_eval.call_count == 2
    assert mock_exec.call_count == 3


@patch('nemo_backend.plan_execute._planner_chain')
@pytest.mark.asyncio(loop_scope='function')
async def test_discovery_summary_passed_to_planner(mock_planner_chain: MagicMock) -> None:
    mock_chain = MagicMock()
    mock_chain.ainvoke = AsyncMock(return_value=PlanModel(steps=['Step 1']))
    mock_planner_chain.return_value = mock_chain

    session = SessionState()
    await _invoke_planner(
        'Build feature',
        session=session,
        apply_mode=True,
        discovery_summary='Auth is in middleware/auth.py',
    )

    mock_planner_chain.assert_called_once()
    assert mock_planner_chain.call_args.kwargs['discovery_summary'] == 'Auth is in middleware/auth.py'
    mock_chain.ainvoke.assert_called_once()


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@patch('nemo_backend.plan_execute.invoke_discovery_evaluation')
@patch('nemo_backend.plan_execute.invoke_discovery_intent')
@pytest.mark.asyncio(loop_scope='function')
async def test_discovery_uses_read_only_tools(
    mock_intent: AsyncMock,
    mock_eval: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
    mock_verify: AsyncMock,
) -> None:
    mock_intent.return_value = DiscoveryIntentModel(actions=['List workspace'])
    mock_eval.return_value = DiscoveryEvaluationModel(ready_to_plan=True, summary='Listed.')
    mock_planner.return_value = PlanModel(steps=['Do work'])
    mock_replanner.return_value = ReplanAct(response='Done.', steps=[])
    mock_pause.return_value = None
    mock_verify.return_value = _approved_verifier()

    discovery_apply_modes: list[bool] = []

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        apply_mode = _args[1] if len(_args) > 1 else _kwargs.get('apply_mode')
        discovery_apply_modes.append(bool(apply_mode))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        if len(discovery_apply_modes) == 1:
            outcome.mark_completed(final_text='Listed workspace.')
            yield 'data: {"type":"chunk"}\n\n'
            return
        outcome.mark_completed(final_text='Step done.')
        yield 'data: {"type":"chunk"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-discovery-readonly',
            outcome=outcome,
        )
    )

    assert discovery_apply_modes[0] is False
    assert discovery_apply_modes[-1] is True
