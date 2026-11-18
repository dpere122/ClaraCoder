from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.plan.build_plan_store import ActionStep, BuildPlanModel, FileChangeEntry, render_build_plan_md
from clara_coder_backend.domain import SessionState
from clara_coder_backend.plan.plan_discovery import (
    PLAN_DISCOVERY_EXECUTE_LABEL,
    build_answer_lookup_prompt,
    build_freeform_discovery_prompt,
    parse_discovery_unknowns,
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


def test_build_answer_lookup_prompt_is_read_only_and_scoped_to_typed_answers() -> None:
    prompt = build_answer_lookup_prompt(
        'Add an auth middleware',
        typed_answers='Q: Where should tokens come from?\nA: the vault client in lib/secrets',
        prior_summary='Relevant files: src/auth.ts (request handler).',
    )
    assert 'Add an auth middleware' in prompt
    assert 'the vault client in lib/secrets' in prompt
    assert 'src/auth.ts (request handler)' in prompt
    assert 'read-only' in prompt.lower()
    assert 'do not re-explore' in prompt.lower()
    assert 'stop immediately' in prompt.lower()
    assert 'NEW findings' in prompt


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


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


def test_discovery_prompts_offer_read_only_subagents() -> None:
    prompt = build_freeform_discovery_prompt('Add plane sounds')
    assert 'spawn_subagent' in prompt
    assert 'read-only here' in prompt


def test_discovery_prompt_asks_for_unknowns_as_questions_with_answers() -> None:
    prompt = build_freeform_discovery_prompt('Add plane sounds')
    assert 'Unknowns' in prompt
    assert 'phrased as a question' in prompt
    assert 'sub-bullets' in prompt


def test_parse_discovery_unknowns_reads_a_numbered_section_under_a_markdown_heading() -> None:
    summary = (
        '## Discovery summary\n\n'
        '### Constraints\n'
        '- **No regressions:** the label still renders.\n\n'
        '### Unknowns (questions for you)\n'
        '1. **Remove the Update button entirely?** Or keep it next to the label? "Actually" suggests removing it.\n'
        '2. **What should the "!" look like?** Options: plain text, or the `triangle-alert` icon.\n'
        '3. **How often should it check?** Once at startup, or also on focus?\n'
    )
    questions = parse_discovery_unknowns(summary)
    assert [q.id for q in questions] == ['q-1', 'q-2', 'q-3']
    assert questions[0].prompt.startswith('Remove the Update button entirely? Or keep it')
    assert '**' not in questions[1].prompt
    assert all(q.options == [] for q in questions)


def test_parse_discovery_unknowns_reads_nested_answers_and_stops_at_the_next_section() -> None:
    summary = (
        '- Relevant files:\n'
        '  - src/app.ts: the handler.\n'
        '- **Unknowns:**\n'
        '  - Should the old button stay?\n'
        '    - Remove it\n'
        '    - Keep it beside the label\n'
        '  - Which colour for the badge?\n'
        '    1. Warning\n'
        '    2. Accent\n'
        '- Constraints: tests must pass.\n'
    )
    questions = parse_discovery_unknowns(summary)
    assert [(q.prompt, q.options) for q in questions] == [
        ('Should the old button stay?', ['Remove it', 'Keep it beside the label']),
        ('Which colour for the badge?', ['Warning', 'Accent']),
    ]


@pytest.mark.parametrize(
    'summary',
    [
        '',
        'Relevant files:\n- src/app.ts: the handler.',
        'Unknowns: none.',
        '**Unknowns**\n- None; the objective is fully specified.',
        'Constraints:\n- Unknowns in the API are documented in docs/api.md.',
        '### Unknowns\n- No blocking unknowns; the objective is fully specified.',
        '### Unknowns\n- There are no decisions left for the user.',
        '**Unknowns:** No user decisions are needed.',
        # The bullets after a bulleted heading are the next sections, not questions.
        '- **Relevant files:** src/app.ts\n- **Unknowns:** None.\n- **Suggested approach:** Add a handler.',
    ],
)
def test_parse_discovery_unknowns_is_empty_without_real_unknowns(summary: str) -> None:
    assert parse_discovery_unknowns(summary) == []


def test_parse_discovery_unknowns_takes_a_question_written_on_the_heading_line() -> None:
    questions = parse_discovery_unknowns('Unknowns: should the cache survive a restart?\n\nThat is all.')
    assert [q.prompt for q in questions] == ['should the cache survive a restart?']


def test_parse_discovery_unknowns_stops_at_the_bullet_after_a_bulleted_heading() -> None:
    summary = (
        '- Relevant files: src/app.ts\n'
        '- Unknowns: Should the cache survive a restart?\n'
        '- Constraints: tests must pass.\n'
    )
    assert [q.prompt for q in parse_discovery_unknowns(summary)] == ['Should the cache survive a restart?']


def test_parse_discovery_unknowns_keeps_code_names_as_written() -> None:
    summary = (
        'Unknowns:\n'
        '- **Should `__init__.py` re-export the helper?**\n'
        '  - Yes, add it to `__all__`\n'
        '  - No, import it from __future__ callers only\n'
        '- **Should the watcher cover `src/**/*.ts` only?**\n'
    )
    questions = parse_discovery_unknowns(summary)
    assert [(q.prompt, q.options) for q in questions] == [
        (
            'Should `__init__.py` re-export the helper?',
            ['Yes, add it to `__all__`', 'No, import it from __future__ callers only'],
        ),
        ('Should the watcher cover `src/**/*.ts` only?', []),
    ]


def test_parse_discovery_unknowns_joins_wrapped_lines_and_leaves_out_notes_and_labels() -> None:
    summary = (
        '### 4. Unknowns for you\n'
        '1. Should the old button stay, or\n'
        '   should it go when the label is clickable?\n'
        '   Options:\n'
        '   - Remove it\n'
        '     - simplest; matches the request\n'
        '   - Keep it beside\n'
        '     the label\n'
        '2. Which colour for the badge?\n'
        '   a) Warning\n'
        '   b) Accent\n'
    )
    questions = parse_discovery_unknowns(summary)
    assert [(q.id, q.prompt, q.options) for q in questions] == [
        (
            'q-1',
            'Should the old button stay, or should it go when the label is clickable?',
            ['Remove it', 'Keep it beside the label'],
        ),
        ('q-2', 'Which colour for the badge?', ['Warning', 'Accent']),
    ]
