from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.plan.build_plan_store import ActionStep, BuildPlanModel, FileChangeEntry, render_build_plan_md
from clara_coder_backend.domain import SessionState
from clara_coder_backend.plan.plan_discovery import (
    PLAN_DISCOVERY_EXECUTE_LABEL,
    build_followup_discovery_prompt,
    build_freeform_discovery_prompt,
)
from clara_coder_backend.plan.plan_execute import (
    _planner_markdown_chain,
    stream_plan_execute_langgraph,
)


def test_build_freeform_discovery_prompt_is_read_only_and_unplanned() -> None:
    prompt = build_freeform_discovery_prompt('Add an auth middleware')
    assert 'Add an auth middleware' in prompt
    assert 'read-only' in prompt.lower()
    assert 'do not' in prompt.lower()
    assert 'checklist' in prompt.lower()


def test_build_followup_discovery_prompt_uses_answers_and_stays_read_only() -> None:
    prompt = build_followup_discovery_prompt(
        'Add an auth middleware',
        resolved_answers='Q: Use REST or gRPC?\nA: REST',
        prior_summary='Found src/auth.ts handler.',
    )
    assert 'Add an auth middleware' in prompt
    assert 'REST' in prompt
    assert 'Found src/auth.ts handler.' in prompt
    assert 'follow-up discovery' in prompt.lower()
    assert 'read-only' in prompt.lower()
    assert 'do not' in prompt.lower()
    assert 'checklist' in prompt.lower()
    assert 'NEW findings' in prompt


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


@pytest.fixture(autouse=True)
def _workspace_has_planned_file(tmp_path) -> None:
    """The sample plan modifies ``src/a.ts``; it exists so the on-disk path check has nothing to ask."""
    (tmp_path / 'src').mkdir(exist_ok=True)
    (tmp_path / 'src' / 'a.ts').write_text('', encoding='utf-8')


def _sample_plan() -> BuildPlanModel:
    return BuildPlanModel(
        title='Plan',
        task='Build feature',
        current_implementation='None',
        files_to_change=[FileChangeEntry(path='src/a.ts', operation='modify', rationale='edit')],
        action_steps=[ActionStep(id='step-1', goal='Do work')],
    )


async def _fake_stream_planner_md(*_args: Any, **kwargs: Any):
    md_out: list[str] = kwargs['md_out']
    record = kwargs['record']
    md = render_build_plan_md(_sample_plan())
    md_out.clear()
    md_out.append(md)
    import json

    payload = {
        'type': 'build_plan_chunk',
        'buildPlanChunk': {'relativePath': record.relative_path, 'content': md},
    }
    yield f'data: {json.dumps(payload, ensure_ascii=False)}\n\n'


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_freeform_discovery_runs_before_planner(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path,
) -> None:
    mock_planner.side_effect = _fake_stream_planner_md
    mock_pause.return_value = None

    exec_apply_modes: list[bool] = []
    call_count = {'n': 0}

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        apply_mode = _args[1] if len(_args) > 1 else _kwargs.get('apply_mode')
        exec_apply_modes.append(bool(apply_mode))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        call_count['n'] += 1
        if call_count['n'] == 1:
            outcome.mark_completed(final_text='Found src/a.ts handler.')
        else:
            outcome.mark_completed(final_text='Found auth middleware.')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState(workspace_path=str(tmp_path))
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
    assert exec_apply_modes[0] is False
    assert exec_apply_modes[-1] is True
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@pytest.mark.asyncio(loop_scope='function')
async def test_freeform_discovery_emits_no_step_checklist(
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path,
) -> None:
    mock_planner.side_effect = _fake_stream_planner_md
    mock_pause.return_value = None

    call_count = {'n': 0}

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        call_count['n'] += 1
        if call_count['n'] == 1:
            outcome.mark_completed(final_text='Explored src/a.ts.')
        else:
            outcome.mark_completed(final_text='Explored workspace.')
        yield 'data: {"type":"chunk"}\n\n'

    mock_exec.side_effect = _fake_exec

    session = SessionState(workspace_path=str(tmp_path))
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

    discovery_lines = [line for line in lines if '"phase": "discovery"' in line]
    assert discovery_lines
    assert all('"steps": []' in line for line in discovery_lines)


@patch('clara_coder_backend.plan.plan_execute.build_llm')
def test_discovery_summary_passed_to_planner_markdown(mock_llm: MagicMock) -> None:
    mock_llm.return_value = MagicMock()
    chain = _planner_markdown_chain('planner-context', discovery_summary='Auth is in middleware/auth.py')
    system = chain.first.format_messages(messages=[])[0].content
    assert 'Auth is in middleware/auth.py' in system
    assert '# Build Plan:' in system


def test_plan_discovery_execute_label_is_stable() -> None:
    assert PLAN_DISCOVERY_EXECUTE_LABEL == 'plan_discovery'
