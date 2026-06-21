from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nemo_backend.agent_loop import AgentLoopOutcome, LangGraphWorkerOutcome
from nemo_backend.domain import SessionState
from nemo_backend.plan_discovery import (
    PLAN_DISCOVERY_EXECUTE_LABEL,
    build_freeform_discovery_prompt,
)
from nemo_backend.plan_execute import (
    PlanModel,
    ReplanAct,
    _invoke_planner,
    stream_plan_execute_langgraph,
)
from nemo_backend.plan_step_verify import StepVerifyResult


def test_build_freeform_discovery_prompt_is_read_only_and_unplanned() -> None:
    prompt = build_freeform_discovery_prompt('Add an auth middleware')
    assert 'Add an auth middleware' in prompt
    assert 'read-only' in prompt.lower()
    # The model must NOT draft an up-front checklist of discovery actions.
    assert 'do not' in prompt.lower()
    assert 'checklist' in prompt.lower()


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


def _approved_verifier() -> StepVerifyResult:
    return StepVerifyResult(approved=True, evidence='Step satisfied.')


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_freeform_discovery_runs_before_planner(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
    mock_verify: AsyncMock,
) -> None:
    mock_planner.return_value = PlanModel(steps=['Do work'])
    mock_replanner.return_value = ReplanAct(response='All done.', steps=[])
    mock_pause.return_value = None
    mock_verify.return_value = _approved_verifier()

    exec_apply_modes: list[bool] = []

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        apply_mode = _args[1] if len(_args) > 1 else _kwargs.get('apply_mode')
        exec_apply_modes.append(bool(apply_mode))
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

    assert mock_planner.called
    assert any('"phase": "discovery"' in line for line in lines)
    assert any('"phase": "planning"' in line for line in lines)
    # Discovery is a single read-only pass (apply_mode False); steps run with full tools.
    assert exec_apply_modes[0] is False
    assert exec_apply_modes[-1] is True
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_freeform_discovery_emits_no_step_checklist(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
    mock_verify: AsyncMock,
) -> None:
    mock_planner.return_value = PlanModel(steps=['Do work'])
    mock_replanner.return_value = ReplanAct(response='Done.', steps=[])
    mock_pause.return_value = None
    mock_verify.return_value = _approved_verifier()

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Explored workspace.')
        yield 'data: {"type":"chunk"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    lines = await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-discovery-no-list',
            outcome=outcome,
        )
    )

    # The discovery phase progress event carries an empty step list (no a-priori plan).
    discovery_lines = [line for line in lines if '"phase": "discovery"' in line]
    assert discovery_lines
    assert all('"steps": []' in line for line in discovery_lines)


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


def test_plan_discovery_execute_label_is_stable() -> None:
    assert PLAN_DISCOVERY_EXECUTE_LABEL == 'plan_discovery'
