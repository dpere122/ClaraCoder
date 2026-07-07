from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nemo_backend.agent_loop import AgentLoopOutcome, LangGraphWorkerOutcome
from nemo_backend.build_plan_store import ActionStep, BuildPlanModel, OpenQuestion, render_build_plan_md
from nemo_backend.domain import SessionState
from nemo_backend.plan_confirm import (
    execute_pending_plan_confirm_decision,
    plan_confirm_sse_payload,
    stage_plan_confirm_request,
)
from nemo_backend.plan_execute import (
    PLAN_DRAFTING_OVERRIDE,
    PLAN_EXECUTE_APPLY_MODE,
    _build_discovery_preamble,
    _grounding_gap_questions,
    _invoke_planner,
    _planner_chain,
    _planner_markdown_chain,
    build_build_plan_executor_prompt,
    build_planner_context_block,
    stream_plan_execute_langgraph,
)
from nemo_backend.tool_registry import format_tools_catalog, plan_execute_tools_and_map, worker_tools_and_map
from nemo_backend.tools.build_plan_tools import read_build_plan
from nemo_backend.tools.workspace import read_workspace_file
from nemo_backend.state import get_session


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


def _sample_plan() -> BuildPlanModel:
    return BuildPlanModel(
        title='Feature plan',
        task='Build the feature',
        current_implementation='Legacy handler in place',
        files_to_change=['src/app.ts — update handler'],
        action_steps=[
            ActionStep(id='step-1', goal='Implement change'),
            ActionStep(id='step-2', goal='Run tests'),
        ],
    )


def test_plan_execute_apply_mode_is_always_true() -> None:
    assert PLAN_EXECUTE_APPLY_MODE is True


def test_build_planner_context_block_includes_staging_tools_in_plan_mode() -> None:
    session = SessionState()
    block = build_planner_context_block(session, apply_mode=PLAN_EXECUTE_APPLY_MODE)
    assert 'transfer_staged_file_to_workspace' in block
    assert 'read_build_plan' in block


def test_build_build_plan_executor_prompt_references_plan_and_mark_tool() -> None:
    prompt = build_build_plan_executor_prompt('.nemo/build-plans/plan-abc.md')
    assert 'read_build_plan' in prompt
    assert 'mark_build_plan_steps_complete' in prompt
    assert 'own pace' in prompt.lower()


def test_format_tools_catalog_includes_name_and_description() -> None:
    catalog = format_tools_catalog([read_workspace_file, read_build_plan])
    assert '`read_workspace_file`' in catalog
    assert catalog.startswith('- ')
    assert '**' in catalog
    assert '—' in catalog


def test_plan_execute_tools_include_build_plan_helpers() -> None:
    session = SessionState()
    tools, mapping = plan_execute_tools_and_map(session=session)
    names = {t.name for t in tools}
    assert 'read_build_plan' in names
    assert 'mark_build_plan_steps_complete' in names
    assert mapping['read_build_plan'] is not None


def test_build_planner_context_block_includes_system_prompt_and_tools() -> None:
    session = SessionState(workspace_path='/tmp/ws')
    block = build_planner_context_block(session, apply_mode=True)
    assert 'You are Clara' in block
    assert 'Available tools' in block
    tools, _ = worker_tools_and_map(True, session=session)
    assert f'`{tools[0].name}`' in block


def test_build_planner_context_block_includes_plan_drafting_override_for_initial_plan() -> None:
    session = SessionState()
    block = build_planner_context_block(session, apply_mode=True, for_initial_plan=True)
    assert PLAN_DRAFTING_OVERRIDE.split('\n')[0] in block


def test_build_discovery_preamble_includes_findings() -> None:
    preamble = _build_discovery_preamble('Auth is in middleware/auth.py')
    assert 'Auth is in middleware/auth.py' in preamble


def test_grounding_gap_questions_flags_ungrounded_paths() -> None:
    plan = _sample_plan()  # files_to_change=['src/app.ts — update handler']
    gaps = _grounding_gap_questions(plan, 'Discovery looked at src/other.ts and tests/foo.py')
    assert len(gaps) == 1
    assert 'src/app.ts' in gaps[0].prompt


def test_grounding_gap_questions_empty_when_grounded() -> None:
    plan = _sample_plan()
    gaps = _grounding_gap_questions(plan, 'Discovery confirmed src/app.ts handler exists.')
    assert gaps == []


def test_grounding_gap_questions_no_summary_returns_empty() -> None:
    plan = _sample_plan()
    assert _grounding_gap_questions(plan, '') == []


@patch('nemo_backend.plan_execute.build_llm')
def test_planner_markdown_chain_prompt_requires_markdown_template(mock_llm: MagicMock) -> None:
    mock_llm.return_value = MagicMock()
    chain = _planner_markdown_chain('planner-context', discovery_summary='Auth in middleware')
    system = chain.first.format_messages(messages=[])[0].content
    assert '# Build Plan:' in system
    assert 'step-id' in system
    assert 'Auth in middleware' in system


@patch('nemo_backend.plan_execute.build_llm')
def test_planner_chain_prompt_requires_build_plan_sections(mock_llm: MagicMock) -> None:
    mock_llm.return_value.with_structured_output.return_value = MagicMock()
    chain = _planner_chain('planner-context', discovery_summary='')
    system = chain.first.format_messages(messages=[])[0].content
    assert 'action_steps' in system.lower()
    assert 'current_implementation' in system.lower()


def test_plan_confirm_sse_payload_includes_build_plan_path() -> None:
    session = SessionState()
    pending = stage_plan_confirm_request(
        session,
        steps=['A', 'B'],
        build_plan_id='plan-abc',
        build_plan_path='.nemo/build-plans/plan-abc.md',
    )
    payload = plan_confirm_sse_payload(pending)
    assert payload['planId'] == 'plan-abc'
    assert payload['buildPlanPath'] == '.nemo/build-plans/plan-abc.md'


def _sample_plan_md() -> str:
    return render_build_plan_md(_sample_plan())


async def _fake_stream_planner_md(*_args: Any, **kwargs: Any):
    md_out: list[str] = kwargs['md_out']
    record = kwargs['record']
    md = _sample_plan_md()
    md_out.clear()
    md_out.append(md)
    import json

    payload = {
        'type': 'build_plan_chunk',
        'buildPlanChunk': {'relativePath': record.relative_path, 'content': md},
    }
    yield f'data: {json.dumps(payload, ensure_ascii=False)}\n\n'


@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._stream_planner_md')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_aborts_when_plan_not_confirmed(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    mock_planner.side_effect = _fake_stream_planner_md

    exec_apply_modes: list[bool] = []

    call_count = {'n': 0}

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        exec_apply_modes.append(bool(_args[1] if len(_args) > 1 else _kwargs.get('apply_mode')))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        call_count['n'] += 1
        if call_count['n'] == 1:
            outcome.mark_completed(final_text='Discovery confirmed src/app.ts handler exists.')
        else:
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

    session = SessionState(workspace_path=str(tmp_path))
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
    assert any('"type": "build_plan_open"' in line for line in lines)
    assert any('"type": "build_plan_chunk"' in line for line in lines)
    open_idx = next(i for i, line in enumerate(lines) if '"type": "build_plan_open"' in line)
    chunk_idx = next(i for i, line in enumerate(lines) if '"type": "build_plan_chunk"' in line)
    assert open_idx < chunk_idx
    assert outcome.state == AgentLoopOutcome.ABORTED
    assert exec_apply_modes == [False]


@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._stream_planner_md')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_single_executor_after_confirm(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    mock_planner.side_effect = _fake_stream_planner_md
    mock_pause.return_value = None

    exec_calls: list[str] = []
    call_count = {'n': 0}

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        prompt = _args[2] if len(_args) > 2 else _kwargs.get('user_message', '')
        exec_calls.append(str(prompt))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        call_count['n'] += 1
        if call_count['n'] == 1:
            outcome.mark_completed(final_text='Discovery confirmed src/app.ts handler exists.')
        else:
            outcome.mark_completed(final_text='Plan execution finished.')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState(workspace_path=str(tmp_path))
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
    assert mock_exec.call_count == 2
    assert 'mark_build_plan_steps_complete' in exec_calls[1]
    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == 'Plan execution finished.'


def _sample_plan_with_open_questions_md() -> str:
    return render_build_plan_md(
        BuildPlanModel(
            title='Feature plan',
            task='Build the feature',
            current_implementation='Legacy handler in place',
            files_to_change=['src/app.ts — update handler'],
            open_questions=[
                OpenQuestion(id='q-1', prompt='Use REST or gRPC?', options=['REST', 'gRPC']),
            ],
            action_steps=[ActionStep(id='step-1', goal='Implement change')],
        )
    )


@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._stream_planner_md')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@patch('nemo_backend.plan_execute.await_question_answers')
@patch('nemo_backend.plan_execute._invoke_planner')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_asks_open_questions_then_refines(
    mock_refine: AsyncMock,
    mock_question_pause: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    async def _fake_planner_md(*_args: Any, **kwargs: Any):
        md_out: list[str] = kwargs['md_out']
        md_out.clear()
        md_out.append(_sample_plan_with_open_questions_md())
        yield 'data: {"type":"build_plan_chunk"}\n\n'

    mock_planner.side_effect = _fake_planner_md

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Discovery confirmed src/app.ts handler.')
        yield 'data: {"type":"chunk"}\n\n'

    mock_exec.side_effect = _fake_exec

    mock_question_pause.return_value = [
        {'question_id': 'q-1', 'option_id': 'q-1-opt-1', 'other_text': None},
    ]
    mock_refine.return_value = BuildPlanModel(
        title='Feature plan',
        task='Build the feature',
        current_implementation='Legacy handler in place',
        files_to_change=['src/app.ts — update handler'],
        action_steps=[ActionStep(id='step-1', goal='Implement REST handler')],
    )
    mock_pause.return_value = None

    session = SessionState(workspace_path=str(tmp_path))
    outcome = LangGraphWorkerOutcome()

    lines = await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-q',
            outcome=outcome,
        )
    )

    assert any('"type": "agent_question"' in line for line in lines)
    assert any('"type": "plan_confirm"' in line for line in lines)
    # The resolved answer (REST) should be carried into the confirm payload.
    confirm_line = next(line for line in lines if '"type": "plan_confirm"' in line)
    assert 'resolvedQuestions' in confirm_line
    assert 'REST' in confirm_line
    assert mock_refine.await_count == 1
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('nemo_backend.plan_execute._stream_langgraph_tool_agent')
@patch('nemo_backend.plan_execute._stream_planner_md')
@patch('nemo_backend.plan_execute.await_diff_review_note')
@patch('nemo_backend.plan_execute.await_question_answers')
@pytest.mark.asyncio(loop_scope='function')
async def test_stream_plan_execute_question_cancel_aborts(
    mock_question_pause: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    async def _fake_planner_md(*_args: Any, **kwargs: Any):
        md_out: list[str] = kwargs['md_out']
        md_out.clear()
        md_out.append(_sample_plan_with_open_questions_md())
        yield 'data: {"type":"build_plan_chunk"}\n\n'

    mock_planner.side_effect = _fake_planner_md

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Discovery confirmed src/app.ts handler.')
        yield 'data: {"type":"chunk"}\n\n'

    mock_exec.side_effect = _fake_exec

    async def _cancel_questions(sid: str) -> list[dict]:
        sess = get_session(sid)
        sess.question_aborted = True
        return []

    mock_question_pause.side_effect = _cancel_questions

    session = SessionState(workspace_path=str(tmp_path))
    from nemo_backend.state import sessions

    sessions['sess-plan-q-cancel'] = session
    outcome = LangGraphWorkerOutcome()

    lines = await _collect_lines(
        stream_plan_execute_langgraph(
            session,
            'Build feature',
            True,
            session_id='sess-plan-q-cancel',
            outcome=outcome,
        )
    )

    assert any('"type": "agent_question"' in line for line in lines)
    assert not any('"type": "plan_confirm"' in line for line in lines)
    assert outcome.state == AgentLoopOutcome.ABORTED
