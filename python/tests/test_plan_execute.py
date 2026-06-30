from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nemo_backend.agent_loop import AgentLoopOutcome, LangGraphWorkerOutcome
from nemo_backend.domain import SessionState
from nemo_backend.plan_confirm import (
    execute_pending_plan_confirm_decision,
    plan_confirm_sse_payload,
    stage_plan_confirm_request,
)
from nemo_backend.plan_execute import (
    PLAN_DRAFTING_OVERRIDE,
    PLAN_EXECUTE_APPLY_MODE,
    PlanModel,
    ReplanAct,
    _append_new_plan_steps,
    _build_discovery_preamble,
    _planner_chain,
    build_planner_context_block,
    build_step_task_prompt,
    stream_plan_execute_langgraph,
)
from nemo_backend.plan_step_verify import StepVerifyResult
from nemo_backend.tool_registry import format_tools_catalog, worker_tools_and_map
from nemo_backend.tools.workspace import read_workspace_file
from nemo_backend.state import get_session


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


def test_plan_execute_apply_mode_is_always_true() -> None:
    assert PLAN_EXECUTE_APPLY_MODE is True


def test_build_planner_context_block_includes_staging_tools_in_plan_mode() -> None:
    session = SessionState()
    block = build_planner_context_block(session, apply_mode=PLAN_EXECUTE_APPLY_MODE)
    assert 'transfer_staged_file_to_workspace' in block
    assert 'stage_create_file' in block


def test_build_step_task_prompt_requires_immediate_execution() -> None:
    prompt = build_step_task_prompt(['Read file', 'Apply edit'], 0)
    assert 'this step now' in prompt.lower()
    assert 'queued' in prompt.lower()


def _approved_verifier() -> StepVerifyResult:
    return StepVerifyResult(approved=True, evidence='Step satisfied.')


def test_append_new_plan_steps_skips_completed_and_dedupes() -> None:
    all_step_texts = ['A', 'B']
    step_states = ['complete', 'pending']
    step_added_flags = [False, False]
    past_steps = [('A', 'done')]
    queued = _append_new_plan_steps(
        ['A', 'B', 'C', 'C'],
        all_step_texts=all_step_texts,
        step_states=step_states,
        step_added_flags=step_added_flags,
        past_steps=past_steps,
    )
    assert all_step_texts == ['A', 'B', 'C']
    assert step_states == ['complete', 'pending', 'pending']
    assert step_added_flags == [False, False, True]
    assert queued == ['B', 'C']


def test_format_tools_catalog_includes_name_and_description() -> None:
    catalog = format_tools_catalog([read_workspace_file])
    assert '`read_workspace_file`' in catalog
    assert catalog.startswith('- ')


def test_build_planner_context_block_includes_system_prompt_and_tools() -> None:
    session = SessionState(workspace_path='/tmp/ws')
    block = build_planner_context_block(session, apply_mode=True)
    assert 'You are Clara' in block
    assert 'Available tools' in block
    tools, _ = worker_tools_and_map(True, session=session)
    assert f'`{tools[0].name}`' in block


def test_build_planner_context_block_read_only_when_editor_off() -> None:
    session = SessionState()
    block = build_planner_context_block(session, apply_mode=False)
    assert 'Editor mode is off' in block
    tools, _ = worker_tools_and_map(False, session=session)
    assert len(tools) > 0
    assert all(f'`{t.name}`' in block for t in tools)


def test_build_planner_context_block_includes_plan_drafting_override_for_initial_plan() -> None:
    session = SessionState()
    block = build_planner_context_block(session, apply_mode=True, for_initial_plan=True)
    assert PLAN_DRAFTING_OVERRIDE.split('\n')[0] in block
    assert 'do not plan exploration steps' in block.lower()


def test_build_planner_context_block_omits_plan_drafting_override_for_replanner() -> None:
    session = SessionState()
    block = build_planner_context_block(session, apply_mode=True, for_initial_plan=False)
    assert 'Plan drafting override' not in block


def test_build_discovery_preamble_empty_summary() -> None:
    preamble = _build_discovery_preamble('')
    assert 'Discovery has already run' in preamble
    assert 'no additional findings' in preamble.lower()
    assert 'read-only discovery' in preamble.lower()


def test_build_discovery_preamble_includes_findings() -> None:
    preamble = _build_discovery_preamble('Auth is in middleware/auth.py')
    assert 'Auth is in middleware/auth.py' in preamble
    assert 'read-only discovery' in preamble.lower()


@patch('nemo_backend.plan_execute.build_llm')
def test_planner_chain_prompt_requires_implementation_only_empty_discovery(
    mock_llm: MagicMock,
) -> None:
    mock_llm.return_value.with_structured_output.return_value = MagicMock()
    chain = _planner_chain('planner-context', discovery_summary='')
    system = chain.first.format_messages(messages=[])[0].content
    assert 'implementation' in system.lower()
    assert 'read-only discovery' in system.lower()
    assert 'Discovery has already run' in system


@patch('nemo_backend.plan_execute.build_llm')
def test_planner_chain_prompt_includes_findings_and_no_discovery_rule(
    mock_llm: MagicMock,
) -> None:
    mock_llm.return_value.with_structured_output.return_value = MagicMock()
    chain = _planner_chain('planner-context', discovery_summary='Auth is in middleware/auth.py')
    system = chain.first.format_messages(messages=[])[0].content
    assert 'Auth is in middleware/auth.py' in system
    assert 'read-only discovery' in system.lower()
    assert 'implementation' in system.lower()


def test_plan_confirm_sse_payload_shape() -> None:
    session = SessionState()
    pending = stage_plan_confirm_request(session, steps=['A', 'B'])
    payload = plan_confirm_sse_payload(pending)
    assert payload['version'] == 1
    assert payload['steps'] == ['A', 'B']
    assert payload['requestId']


def test_execute_pending_plan_confirm_cancel_sets_abort_flag() -> None:
    session = SessionState()
    stage_plan_confirm_request(session, steps=['Only step'])
    rid = session.pending_plan_confirm_request['request_id']
    note = execute_pending_plan_confirm_decision(session, confirm=False, request_id=rid)
    assert session.plan_execute_aborted is True
    assert 'cancelled' in note.lower()


@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_aborts_when_plan_not_confirmed(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
) -> None:
    mock_planner.return_value = PlanModel(steps=['Do work'])

    exec_apply_modes: list[bool] = []

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        exec_apply_modes.append(bool(_args[1] if len(_args) > 1 else _kwargs.get('apply_mode')))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Discovery done.')
        yield 'data: {"type":"chunk"}\n\n'

    mock_exec.side_effect = _fake_exec

    async def _pause_and_cancel(sid: str) -> None:
        sess = get_session(sid)
        execute_pending_plan_confirm_decision(
            sess,
            confirm=False,
            request_id=sess.pending_plan_confirm_request['request_id'],
        )

    mock_pause.side_effect = _pause_and_cancel

    session = SessionState()
    from nemo_backend.state import sessions

    sessions['sess-plan-cancel'] = session
    outcome = LangGraphWorkerOutcome()

    lines = await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-cancel',
            outcome=outcome,
        )
    )

    assert any('"type": "plan_confirm"' in line for line in lines)
    assert outcome.state == AgentLoopOutcome.ABORTED
    # Only the read-only discovery pass runs; no plan step executes after cancel.
    assert exec_apply_modes == [False]
    mock_replanner.assert_not_called()


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_runs_executor_after_confirm(
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

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Step done.')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    lines = await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-ok',
            outcome=outcome,
        )
    )

    assert any('"type": "planner_progress"' in line for line in lines)
    assert mock_exec.called
    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == 'All done.'


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_runs_all_approved_steps_before_replan(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
    mock_verify: AsyncMock,
) -> None:
    mock_planner.return_value = PlanModel(steps=['Step A', 'Step B', 'Step C'])
    mock_replanner.return_value = ReplanAct(response='All done.', steps=[])
    mock_pause.return_value = None
    mock_verify.return_value = _approved_verifier()

    exec_calls: list[str] = []

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        prompt = _args[2] if len(_args) > 2 else _kwargs.get('user_message', '')
        exec_calls.append(str(prompt))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Step done.')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-ignore-replan',
            outcome=outcome,
        )
    )

    # exec_calls[0] is the free-form discovery pass; steps follow.
    step_calls = exec_calls[1:]
    assert len(step_calls) == 3
    assert 'step 1' in step_calls[0].lower()
    assert 'step 2' in step_calls[1].lower()
    assert 'step 3' in step_calls[2].lower()
    assert mock_replanner.call_count == 1
    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == 'All done.'


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_does_not_stop_after_first_step(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
    mock_verify: AsyncMock,
) -> None:
    mock_planner.return_value = PlanModel(steps=['Step A', 'Step B'])
    mock_replanner.return_value = ReplanAct(
        response='Remaining steps are queued; plan complete.',
        steps=[],
    )
    mock_pause.return_value = None
    mock_verify.return_value = _approved_verifier()

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Step done.')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-no-early-stop',
            outcome=outcome,
        )
    )

    # 1 discovery pass + 2 plan steps.
    assert mock_exec.call_count == 3
    assert mock_replanner.call_count == 1
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_uses_full_tool_apply_mode_when_editor_off(
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
        outcome.mark_completed(final_text='Step done.')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            False,
            session_id='sess-plan-editor-off',
            outcome=outcome,
        )
    )

    assert mock_exec.call_args.args[1] is True
    tools, _ = worker_tools_and_map(True, session=session)
    assert 'transfer_staged_file_to_workspace' in {t.name for t in tools}


@patch('nemo_backend.plan_execute.invoke_step_verifier')
@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._invoke_replanner')
@patch('nemo_backend.plan_execute._invoke_planner')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_retries_executor_when_verifier_rejects(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_replanner: AsyncMock,
    mock_exec: AsyncMock,
    mock_verify: AsyncMock,
) -> None:
    mock_planner.return_value = PlanModel(steps=['Do work'])
    mock_replanner.return_value = ReplanAct(response='All done.', steps=[])
    mock_pause.return_value = None
    mock_verify.side_effect = [
        StepVerifyResult(approved=False, feedback='Actually apply the edit.'),
        _approved_verifier(),
    ]

    exec_calls: list[str] = []

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        prompt = _args[2] if len(_args) > 2 else _kwargs.get('user_message', '')
        exec_calls.append(str(prompt))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Step done.')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState()
    outcome = LangGraphWorkerOutcome()

    await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-verify-retry',
            outcome=outcome,
        )
    )

    # exec_calls[0] is the discovery pass; the step runs twice (initial + verifier retry).
    assert len(exec_calls) == 3
    assert 'Verifier feedback' in exec_calls[2]
    assert mock_verify.call_count == 2
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('nemo_backend.agent.stream_single_agent_langgraph')
@patch('nemo_backend.agent.build_llm')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_agent_reply_routes_plan_mode(
    mock_build_llm: MagicMock,
    mock_single: AsyncMock,
) -> None:
    from nemo_backend.agent import stream_agent_reply

    mock_build_llm.return_value = MagicMock()

    async def _empty(*_args: Any, **_kwargs: Any):
        yield 'data: [DONE]\n\n'

    mock_single.side_effect = _empty

    with patch('nemo_backend.agent.stream_plan_execute_langgraph') as mock_plan:
        mock_plan.side_effect = _empty
        lines = await _collect_lines(
            stream_agent_reply('s1', 'hi', composer_mode='plan'),
        )
        assert lines
        mock_plan.assert_called_once()
        mock_single.assert_not_called()
