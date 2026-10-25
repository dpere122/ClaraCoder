from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.plan.build_plan_store import (
    ActionStep,
    BuildPlanModel,
    FileChangeEntry,
    OpenQuestion,
    render_build_plan_md,
)
from clara_coder_backend.domain import SessionState
from clara_coder_backend.plan.plan_confirm import (
    execute_pending_plan_confirm_decision,
    plan_confirm_sse_payload,
    stage_plan_confirm_request,
)
from clara_coder_backend.plan.plan_execute import (
    PLAN_DRAFTING_OVERRIDE,
    PLAN_EXECUTE_APPLY_MODE,
    _bind_answers_into_prior_plan,
    _build_discovery_preamble,
    _coerce_planner_model,
    _finalize_rewritten_plan,
    _planner_markdown_chain,
    _planner_markdown_from_channels,
    _slice_build_plan_markdown,
    build_build_plan_executor_prompt,
    build_planner_context_block,
    stream_plan_execute_langgraph,
)
from clara_coder_backend.hitl.deferred_tool_hitl import deferred_tool_hitl_bypass
from clara_coder_backend.hitl.tool_registry import format_tools_catalog, worker_tools_and_map
from clara_coder_backend.plan.plan_tools_registry import plan_execute_tools_and_map
from clara_coder_backend.plan.build_plan_tools import read_build_plan
from clara_coder_backend.tools.workspace import read_workspace_file
from clara_coder_backend.session.state import get_session


async def _collect_lines(generator: Any) -> list[str]:
    return [line async for line in generator]


@pytest.fixture(autouse=True)
def _workspace_has_planned_file(tmp_path: Path) -> None:
    """Sample plans modify ``src/app.ts``; it exists so the on-disk path check has nothing to ask."""
    (tmp_path / 'src').mkdir(exist_ok=True)
    (tmp_path / 'src' / 'app.ts').write_text('export {};\n', encoding='utf-8')


def _sse_json_rows(lines: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in lines:
        raw = line.strip()
        if raw.startswith('data:'):
            raw = raw[5:].strip()
        if not raw:
            continue
        try:
            rows.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return rows


def _build_plan_chunk_contents(lines: list[str]) -> list[str]:
    return [
        str((row.get('buildPlanChunk') or {}).get('content') or '')
        for row in _sse_json_rows(lines)
        if row.get('type') == 'build_plan_chunk'
    ]


def _sample_plan() -> BuildPlanModel:
    return BuildPlanModel(
        title='Feature plan',
        task='Build the feature',
        current_implementation='Legacy handler in place',
        files_to_change=[
            FileChangeEntry(path='src/app.ts', operation='modify', rationale='update handler'),
        ],
        action_steps=[
            ActionStep(id='step-1', goal='Implement change'),
            ActionStep(id='step-2', goal='Run tests'),
        ],
    )


def test_plan_execute_apply_mode_is_always_true() -> None:
    assert PLAN_EXECUTE_APPLY_MODE is True


def test_build_planner_context_block_includes_edit_tools_in_plan_mode() -> None:
    session = SessionState()
    block = build_planner_context_block(session, apply_mode=PLAN_EXECUTE_APPLY_MODE)
    assert 'write_workspace_file' in block
    assert 'transfer_staged_file_to_workspace' not in block
    assert 'read_build_plan' in block


def test_build_build_plan_executor_prompt_references_plan_and_mark_tool() -> None:
    prompt = build_build_plan_executor_prompt('.clara/build-plans/plan-abc.md')
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


def test_build_planner_context_block_without_tools_catalog_forbids_tool_calls() -> None:
    """The markdown-streaming planner has no tool channel; its context must not advertise tools."""
    session = SessionState(workspace_path='/tmp/ws')
    block = build_planner_context_block(
        session,
        apply_mode=True,
        for_initial_plan=True,
        with_tools_catalog=False,
    )
    assert 'Available tools' not in block
    # The formatted tool catalog (header + per-tool `` `name` `` descriptions) is gone; the
    # explicit no-tools directive is present instead.
    assert 'You have NO tools in this phase' in block
    assert '<tool_call>' in block
    assert 'cannot call any tool' in block


@pytest.mark.asyncio(loop_scope='function')
async def test_stream_planner_md_retries_when_model_emits_tool_call(tmp_path: Path) -> None:
    """A tool-call-as-text first attempt should trigger one retry that yields the real plan."""
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()
    call = {'n': 0}

    class _FakeChain:
        async def astream(self, _inputs: Any):
            if call['n'] == 0:
                yield AIMessageChunk(content='<tool_call>\n<read_workspace_file>\n<path>x</path>\n</read_workspace_file>')
            else:
                yield AIMessageChunk(content=plan_md)
            call['n'] += 1

    def _fake_chain(_ctx: str, *, discovery_summary: str = '', **_kwargs: Any) -> _FakeChain:
        return _FakeChain()
        return _FakeChain()

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-retry', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', side_effect=_fake_chain):
        lines = await _collect_lines(
            _stream_planner_md(
                'Build feature',
                session=session,
                apply_mode=True,
                discovery_summary='discovery found src/app.ts',
                record=record,
                md_out=md_out,
            )
        )

    assert call['n'] == 2
    assert md_out and md_out[0] == plan_md
    assert any('"type": "build_plan_chunk"' in line for line in lines)


@pytest.mark.asyncio(loop_scope='function')
async def test_stream_planner_md_emits_reasoning_chunks(tmp_path: Path) -> None:
    """Reasoning-model sidecar text should stream into the chat auxiliary trail."""
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(
                content='',
                additional_kwargs={'reasoning_content': 'Considering discovery facts.\n'},
            )
            yield AIMessageChunk(content=plan_md)

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-reason', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        lines = await _collect_lines(
            _stream_planner_md(
                'Build feature',
                session=session,
                apply_mode=True,
                discovery_summary='discovery found src/app.ts',
                record=record,
                md_out=md_out,
            )
        )

    assert md_out and md_out[0] == plan_md
    assert any(
        '"type": "chunk"' in line and '"stream_tag": "reasoning"' in line and 'Considering discovery' in line
        for line in lines
    )
    assert any('"type": "build_plan_chunk"' in line for line in lines)


def test_stream_planner_md_strips_gemma_thought_from_document(tmp_path: Path) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(content="<|channel>thought\nI will draft the plan.\n<channel|>")
            yield AIMessageChunk(content=plan_md)

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-gemma-split', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        lines = asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert md_out and md_out[0] == plan_md
    assert '<|channel>' not in md_out[0]
    assert any('"stream_tag": "reasoning"' in line and 'I will draft the plan' in line for line in lines)


def test_stream_planner_md_recovers_plan_written_in_thought_channel(tmp_path: Path) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(content="<|channel>thought\n" + plan_md + "<channel|>")

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-gemma-thought-plan', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert '# Build Plan' in (md_out[0] or '')
    assert 'Implement change' in (md_out[0] or '')
    assert '<|channel>' not in (md_out[0] or '')


def test_slice_build_plan_markdown_ignores_inline_mentions_and_takes_last_heading() -> None:
    plan = _sample_plan_md()
    mixed = (
        'I will write a # Build Plan next after more thinking.\n'
        '# Build Plan: Sketch\n'
        'not the real document\n'
        f'{plan}'
    )
    assert _slice_build_plan_markdown(mixed) == plan
    assert _slice_build_plan_markdown('no heading here') == ''
    assert _planner_markdown_from_channels('preamble only', 'thinking\n' + plan).startswith('# Build Plan:')


def test_stream_planner_md_holds_plan_write_until_heading(tmp_path: Path) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import (
        BUILD_PLAN_DRAFT_STUB,
        create_build_plan_draft,
        read_build_plan_md,
    )
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()
    leaked_thought = 'Still thinking about the architecture and files to change.\n'

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(content=leaked_thought)
            yield AIMessageChunk(content=plan_md)

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-gate-heading', session=session)
    assert read_build_plan_md(str(tmp_path), record) == BUILD_PLAN_DRAFT_STUB
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        lines = asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert md_out and md_out[0] == plan_md
    assert leaked_thought.strip() not in (md_out[0] or '')
    chunks = _build_plan_chunk_contents(lines)
    assert chunks
    for content in chunks:
        assert leaked_thought.strip() not in content
        assert content.startswith('# Build Plan:')
    assert read_build_plan_md(str(tmp_path), record) == plan_md


def test_stream_planner_md_does_not_write_reasoning_to_plan(tmp_path: Path) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft, read_build_plan_md
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()
    thinking = 'Considering discovery facts for a long time before writing anything.\n'

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(content='', additional_kwargs={'reasoning_content': thinking})
            yield AIMessageChunk(content=plan_md)

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-gated-reason', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        lines = asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert md_out and md_out[0] == plan_md
    assert thinking.strip() not in (md_out[0] or '')
    for content in _build_plan_chunk_contents(lines):
        assert thinking.strip() not in content
    disk = read_build_plan_md(str(tmp_path), record)
    assert thinking.strip() not in disk
    assert disk.startswith('# Build Plan:')
    assert any(
        '"stream_tag": "reasoning"' in line and 'Considering discovery facts' in line for line in lines
    )


def test_stream_planner_md_slices_think_block_then_real_plan(tmp_path: Path) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft, read_build_plan_md
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()
    leaked = (
        '<think>\n'
        'I will draft\n'
        '# Build Plan: Sketch\n'
        'this is only thinking\n'
        '</think>\n'
        f'{plan_md}'
    )

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(content=leaked)

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-think-tags', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        lines = asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert md_out and md_out[0] == plan_md
    assert '<think>' not in (md_out[0] or '')
    assert '# Build Plan: Sketch' not in (md_out[0] or '')
    for content in _build_plan_chunk_contents(lines):
        assert '<think>' not in content
        assert content.startswith('# Build Plan:')
    assert read_build_plan_md(str(tmp_path), record) == plan_md


def test_stream_planner_md_recovers_thought_channel_plan_after_preamble(tmp_path: Path) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()
    preamble = 'I will think carefully about auth and routing for a long time.\n\n'

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(content='<|channel>thought\n' + preamble + plan_md + '<channel|>')

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-thought-preamble', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert md_out and md_out[0] == plan_md
    assert preamble.strip() not in (md_out[0] or '')
    assert (md_out[0] or '').startswith('# Build Plan:')


def test_stream_planner_md_drops_thinking_content_blocks_from_plan_file(tmp_path: Path) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft, read_build_plan_md
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    plan_md = _sample_plan_md()
    cot = 'Long CoT about the request that must not land in the plan file.\n'

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(
                content=[
                    {'type': 'thinking', 'text': cot},
                    {'type': 'text', 'text': plan_md},
                ]
            )

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-thinking-blocks', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        lines = asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert md_out and md_out[0] == plan_md
    assert cot.strip() not in (md_out[0] or '')
    for content in _build_plan_chunk_contents(lines):
        assert cot.strip() not in content
    assert read_build_plan_md(str(tmp_path), record) == plan_md


def _sample_gemma_native_plan_markup(*, in_thought_channel: bool = False) -> str:
    call = (
        '<|tool_call>call:BuildPlanModel{'
        'title:<|"|>Feature plan<|"|>,'
        'task:<|"|>Build the feature<|"|>,'
        'current_implementation:<|"|>Legacy handler<|"|>,'
        'action_steps:[{id:<|"|>step-1<|"|>,goal:<|"|>Implement REST handler<|"|>}]'
        '}<tool_call|>'
    )
    if in_thought_channel:
        return f'<|channel>thought\n{call}\n<channel|>Visible briefing'
    return '<|channel>thought\nNeed a structured plan.\n<channel|>' + call


@patch('clara_coder_backend.plan.plan_execute.gemma_output_parsing_active', return_value=True)
def test_stream_planner_md_recovers_gemma_native_tool_call_plan(
    _active: MagicMock,
    tmp_path: Path,
) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(content=_sample_gemma_native_plan_markup())

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-gemma-native-plan', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert '# Build Plan' in (md_out[0] or '')
    assert 'Implement REST handler' in (md_out[0] or '')
    assert '<|tool_call>' not in (md_out[0] or '')


@patch('clara_coder_backend.plan.plan_execute.gemma_output_parsing_active', return_value=True)
def test_stream_planner_md_recovers_native_tool_call_in_thought_channel(
    _active: MagicMock,
    tmp_path: Path,
) -> None:
    from langchain_core.messages import AIMessageChunk

    from clara_coder_backend.plan.build_plan_store import create_build_plan_draft
    from clara_coder_backend.plan.plan_execute import _stream_planner_md

    class _FakeChain:
        async def astream(self, _inputs: Any):
            yield AIMessageChunk(content=_sample_gemma_native_plan_markup(in_thought_channel=True))

    session = SessionState(workspace_path=str(tmp_path))
    record = create_build_plan_draft(str(tmp_path), 'sess-gemma-thought-native', session=session)
    md_out: list[str] = ['']

    with patch('clara_coder_backend.plan.plan_execute._planner_markdown_chain', return_value=_FakeChain()):
        asyncio.run(
            _collect_lines(
                _stream_planner_md(
                    'Build feature',
                    session=session,
                    apply_mode=True,
                    discovery_summary='discovery found src/app.ts',
                    record=record,
                    md_out=md_out,
                )
            )
        )

    assert '# Build Plan' in (md_out[0] or '')
    assert 'Implement REST handler' in (md_out[0] or '')
    assert '<|tool_call>' not in (md_out[0] or '')


def test_build_discovery_preamble_includes_findings() -> None:
    preamble = _build_discovery_preamble('Auth is in middleware/auth.py')
    assert 'Auth is in middleware/auth.py' in preamble


def test_plan_confirm_sse_payload_includes_structured_files_to_change() -> None:
    session = SessionState()
    pending = stage_plan_confirm_request(
        session,
        steps=['A'],
        files_to_change=[
            FileChangeEntry(path='src/new.ts', operation='create', rationale='add module'),
            'src/legacy.ts — old string style',
        ],
    )
    payload = plan_confirm_sse_payload(pending)
    assert payload['filesToChange'] == [
        {'path': 'src/new.ts', 'operation': 'create', 'rationale': 'add module'},
        {'path': 'src/legacy.ts', 'operation': 'modify', 'rationale': 'old string style'},
    ]


@patch('clara_coder_backend.plan.plan_execute.build_llm')
def test_planner_markdown_chain_prompt_requires_markdown_template(mock_llm: MagicMock) -> None:
    mock_llm.return_value = MagicMock()
    chain = _planner_markdown_chain('planner-context', discovery_summary='Auth in middleware')
    system = chain.first.format_messages(messages=[])[0].content
    assert '# Build Plan:' in system
    assert 'step-id' in system
    assert 'Auth in middleware' in system


@patch('clara_coder_backend.plan.plan_execute.build_llm')
def test_planner_markdown_chain_rewrite_includes_answers_and_prior_draft(mock_llm: MagicMock) -> None:
    mock_llm.return_value = MagicMock()
    chain = _planner_markdown_chain(
        'planner-context',
        discovery_summary='Auth in middleware',
        resolved_answers='Q: Use REST or gRPC?\nA: REST',
        prior_plan_md='# Build Plan: Feature plan\n',
    )
    system = chain.first.format_messages(messages=[])[0].content
    assert 'FINAL build plan' in system
    assert 'do not emit an Open Questions section' in system.lower() or 'Open Questions' in system
    assert 'REST' in system
    assert 'Previous build-plan draft' in system
    assert '# Build Plan: Feature plan' in system


def test_plan_confirm_sse_payload_includes_build_plan_path() -> None:
    session = SessionState()
    pending = stage_plan_confirm_request(
        session,
        steps=['A', 'B'],
        build_plan_id='plan-abc',
        build_plan_path='.clara/build-plans/plan-abc.md',
    )
    payload = plan_confirm_sse_payload(pending)
    assert payload['planId'] == 'plan-abc'
    assert payload['buildPlanPath'] == '.clara/build-plans/plan-abc.md'


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


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
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
    from clara_coder_backend.session.state import sessions

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


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
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
    hitl_bypass_by_call: list[bool] = []
    call_count = {'n': 0}

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        prompt = _args[2] if len(_args) > 2 else _kwargs.get('user_message', '')
        exec_calls.append(str(prompt))
        hitl_bypass_by_call.append(bool(deferred_tool_hitl_bypass.get()))
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
    # Discovery may skip accept-command HITL; the executor must not (run_command, etc.).
    assert hitl_bypass_by_call == [True, False]
    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == 'Plan execution finished.'


def _sample_plan_with_open_questions_md() -> str:
    return render_build_plan_md(
        BuildPlanModel(
            title='Feature plan',
            task='Build the feature',
            current_implementation='Legacy handler in place',
            files_to_change=[
                FileChangeEntry(path='src/app.ts', operation='modify', rationale='update handler'),
            ],
            open_questions=[
                OpenQuestion(id='q-1', prompt='Use REST or gRPC?', options=['REST', 'gRPC']),
            ],
            action_steps=[ActionStep(id='step-1', goal='Implement change')],
        )
    )


def _sample_rewritten_plan_md() -> str:
    return render_build_plan_md(
        BuildPlanModel(
            title='Feature plan',
            task='Build the feature',
            current_implementation='Legacy handler in place',
            files_to_change=[
                FileChangeEntry(path='src/app.ts', operation='modify', rationale='update handler'),
            ],
            assumptions=['Use REST or gRPC? → REST'],
            action_steps=[ActionStep(id='step-1', goal='Implement REST handler')],
        )
    )


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@patch('clara_coder_backend.plan.plan_execute.await_question_answers')
def test_stream_plan_execute_asks_open_questions_then_rewrites(
    mock_question_pause: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    planner_calls: list[dict[str, Any]] = []

    async def _fake_planner_md(*_args: Any, **kwargs: Any):
        planner_calls.append(kwargs)
        md_out: list[str] = kwargs['md_out']
        md_out.clear()
        if len(planner_calls) == 1:
            md_out.append(_sample_plan_with_open_questions_md())
        else:
            md_out.append(_sample_rewritten_plan_md())
        yield 'data: {"type":"build_plan_chunk"}\n\n'

    mock_planner.side_effect = _fake_planner_md

    checkpoint_keys: list[str] = []

    async def _fake_exec(*_args: Any, **_kwargs: Any):
        cfg = _kwargs.get('cfg')
        if cfg is not None:
            checkpoint_keys.append(str(getattr(cfg, 'checkpoint_session_key', '') or ''))
        outcome: LangGraphWorkerOutcome = _kwargs['outcome']
        outcome.mark_completed(final_text='Discovery confirmed src/app.ts handler.')
        yield 'data: {"type":"chunk"}\n\n'

    mock_exec.side_effect = _fake_exec

    mock_question_pause.return_value = [
        {'question_id': 'q-1', 'option_id': 'q-1-opt-1', 'other_text': None},
    ]
    mock_pause.return_value = None

    session = SessionState(workspace_path=str(tmp_path))
    outcome = LangGraphWorkerOutcome()

    lines = asyncio.run(
        _collect_lines(
            stream_plan_execute_langgraph(
                session,
                'Build feature',
                True,
                session_id='sess-plan-q',
                outcome=outcome,
            )
        )
    )

    assert any('"type": "agent_question"' in line for line in lines)
    assert sum('"type": "agent_question"' in line for line in lines) == 1
    assert any('"type": "plan_confirm"' in line for line in lines)
    confirm_line = next(line for line in lines if '"type": "plan_confirm"' in line)
    assert 'resolvedQuestions' in confirm_line
    assert 'REST' in confirm_line
    assert len(planner_calls) == 2
    assert 'REST' in (planner_calls[1].get('resolved_answers') or '')
    assert '# Build Plan' in (planner_calls[1].get('prior_plan_md') or '')
    assert any(key.endswith(':plan_discover') for key in checkpoint_keys)
    assert any(key.endswith(':plan_discover_followup') for key in checkpoint_keys)
    assert any('Rewriting plan' in line for line in lines)
    question_idx = next(i for i, line in enumerate(lines) if '"type": "agent_question"' in line)
    rewrite_progress = None
    for line in lines[question_idx:]:
        if '"type": "planner_progress"' not in line:
            continue
        payload = json.loads(line[len('data: '):].strip())
        planner = payload.get('planner') or {}
        if planner.get('phase') == 'planning' and planner.get('planReady') is False and planner.get('steps'):
            rewrite_progress = planner
            break
    assert rewrite_progress is not None
    assert rewrite_progress['steps'][0]['text'] == 'Implement change'
    stub_idx = next(i for i, line in enumerate(lines) if '_Rewriting plan' in line)
    rewritten_idx = next(i for i, line in enumerate(lines) if 'Implement REST handler' in line)
    assert stub_idx < rewritten_idx
    assert outcome.state == AgentLoopOutcome.COMPLETED
    plan_files = list((tmp_path / '.clara' / 'build-plans').glob('plan-*.md'))
    assert plan_files
    disk = plan_files[0].read_text(encoding='utf-8')
    assert 'REST' in disk
    assert '## Open Questions' not in disk
    assert 'Implement REST handler' in disk


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@patch('clara_coder_backend.plan.plan_execute.await_question_answers')
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
    from clara_coder_backend.session.state import sessions

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


def test_coerce_planner_model_from_gemma_native_tool_call() -> None:
    parsed = _coerce_planner_model(_sample_gemma_native_plan_markup())
    assert parsed is not None
    assert parsed.title == 'Feature plan'
    assert parsed.action_steps[0].goal == 'Implement REST handler'


def test_coerce_planner_model_from_thought_wrapped_markdown() -> None:
    md = _sample_plan_md()
    parsed = _coerce_planner_model(f'<|channel>thought\n{md}<channel|>')
    assert parsed is not None
    assert any(step.goal == 'Implement change' for step in parsed.action_steps)


def test_bind_answers_into_prior_plan_strips_questions_and_adds_assumptions() -> None:
    plan = BuildPlanModel(
        title='Feature plan',
        task='Build the feature',
        current_implementation='Legacy handler',
        files_to_change=[
            FileChangeEntry(path='src/app.ts', operation='modify', rationale='update handler'),
        ],
        open_questions=[
            OpenQuestion(id='q-1', prompt='Use REST or gRPC?', options=['REST', 'gRPC']),
        ],
        action_steps=[ActionStep(id='step-1', goal='Implement change')],
    )
    bound = _bind_answers_into_prior_plan(plan, 'Q: Use REST or gRPC?\nA: REST')
    assert bound.open_questions == []
    assert any('REST' in a for a in bound.assumptions)
    md = render_build_plan_md(bound)
    assert '## Open Questions' not in md
    assert 'REST' in md


def test_finalize_rewritten_plan_turns_unverified_paths_into_assumptions(tmp_path: Path) -> None:
    plan = BuildPlanModel(
        title='Feature plan',
        task='Build the feature',
        current_implementation='Legacy handler',
        files_to_change=[
            FileChangeEntry(path='src/missing.ts', operation='modify', rationale='maybe'),
        ],
        open_questions=[
            OpenQuestion(id='q-1', prompt='Should not be asked again?', options=['Yes', 'No']),
        ],
        action_steps=[ActionStep(id='step-1', goal='Implement change')],
    )
    finalized = _finalize_rewritten_plan(plan, str(tmp_path))
    assert finalized.open_questions == []
    assert any('src/missing.ts' in a for a in finalized.assumptions)


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@patch('clara_coder_backend.plan.plan_execute.await_question_answers')
def test_stream_plan_execute_binds_answers_when_rewrite_has_no_steps(
    mock_question_pause: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    planner_calls = {'n': 0}

    async def _fake_planner_md(*_args: Any, **kwargs: Any):
        planner_calls['n'] += 1
        md_out: list[str] = kwargs['md_out']
        md_out.clear()
        if planner_calls['n'] == 1:
            md_out.append(_sample_plan_with_open_questions_md())
        else:
            md_out.append('not a build plan')
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
    mock_pause.return_value = None

    session = SessionState(workspace_path=str(tmp_path))
    outcome = LangGraphWorkerOutcome()

    lines = asyncio.run(
        _collect_lines(
            stream_plan_execute_langgraph(
                session,
                'Build feature',
                True,
                session_id='sess-plan-rewrite-fail',
                outcome=outcome,
            )
        )
    )

    assert sum('"type": "agent_question"' in line for line in lines) == 1
    assert any('"type": "plan_confirm"' in line for line in lines)
    assert any('Plan kept' in line for line in lines)
    assert planner_calls['n'] == 2
    assert outcome.state == AgentLoopOutcome.COMPLETED
    plan_files = list((tmp_path / '.clara' / 'build-plans').glob('plan-*.md'))
    assert plan_files
    disk = plan_files[0].read_text(encoding='utf-8')
    assert 'Feature plan' in disk
    assert 'Implement change' in disk
    assert 'REST' in disk
    assert '## Open Questions' not in disk


def test_build_build_plan_executor_prompt_inlines_plan_and_findings() -> None:
    prompt = build_build_plan_executor_prompt(
        '.clara/build-plans/plan-abc.md',
        plan_md='# Build Plan: Feature\n\n- [ ] Implement change',
        discovery_summary='Relevant files: src/app.ts (request handler).',
    )
    assert '# Build Plan: Feature' in prompt
    assert 'src/app.ts (request handler)' in prompt
    assert 'do not repeat this exploration' in prompt
    assert 'mark_build_plan_steps_complete' in prompt


def test_build_build_plan_executor_prompt_omits_empty_blocks() -> None:
    prompt = build_build_plan_executor_prompt('.clara/build-plans/plan-abc.md')
    assert 'Approved plan' not in prompt
    assert 'Discovery findings' not in prompt


def _two_run_exec(prompts: list[str]):
    """Fake agent runs: discovery first, then the executor."""

    async def _fake_exec(*args: Any, **kwargs: Any):
        prompts.append(str(args[2] if len(args) > 2 else kwargs.get('user_message', '')))
        outcome: LangGraphWorkerOutcome = kwargs['outcome']
        outcome.mark_completed(
            final_text='Discovery found the router.' if len(prompts) == 1 else 'Plan execution finished.'
        )
        yield 'data: {"type":"chunk"}\n\n'

    return _fake_exec


def _planner_md_for(path: str):
    async def _fake_planner_md(*_args: Any, **kwargs: Any):
        md_out: list[str] = kwargs['md_out']
        md_out.clear()
        md_out.append(
            render_build_plan_md(
                BuildPlanModel(
                    title='Router plan',
                    task='Mount auth',
                    current_implementation='Router without auth',
                    files_to_change=[FileChangeEntry(path=path, operation='modify', rationale='mount')],
                    action_steps=[ActionStep(id='step-1', goal='Mount auth', files_touched=[path])],
                )
            )
        )
        yield 'data: {"type":"build_plan_chunk"}\n\n'

    return _fake_planner_md


def _run_plan(session: SessionState, session_id: str, outcome: LangGraphWorkerOutcome) -> list[str]:
    from clara_coder_backend.session.state import sessions

    sessions[session_id] = session
    return asyncio.run(
        _collect_lines(
            stream_plan_execute_langgraph(session, 'Mount auth', True, session_id=session_id, outcome=outcome)
        )
    )


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@patch('clara_coder_backend.plan.plan_execute.await_question_answers')
def test_stream_plan_execute_existing_file_needs_no_question(
    mock_question_pause: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    """Discovery never mentioned the file, but it is on disk: nothing to ask."""
    (tmp_path / 'src' / 'router.ts').write_text('', encoding='utf-8')
    mock_planner.side_effect = _planner_md_for('src/router.ts')
    prompts: list[str] = []
    mock_exec.side_effect = _two_run_exec(prompts)
    mock_pause.return_value = None

    outcome = LangGraphWorkerOutcome()
    lines = _run_plan(SessionState(workspace_path=str(tmp_path)), 'sess-path-exists', outcome)

    assert not any('"type": "agent_question"' in line for line in lines)
    assert mock_question_pause.call_count == 0
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@patch('clara_coder_backend.plan.plan_execute.await_question_answers')
def test_stream_plan_execute_corrects_unique_misplaced_path(
    mock_question_pause: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    (tmp_path / 'src' / 'server').mkdir()
    (tmp_path / 'src' / 'server' / 'router.ts').write_text('', encoding='utf-8')
    mock_planner.side_effect = _planner_md_for('src/router.ts')
    prompts: list[str] = []
    mock_exec.side_effect = _two_run_exec(prompts)
    mock_pause.return_value = None

    outcome = LangGraphWorkerOutcome()
    lines = _run_plan(SessionState(workspace_path=str(tmp_path)), 'sess-path-fix', outcome)

    assert mock_question_pause.call_count == 0
    confirm_line = next(line for line in lines if '"type": "plan_confirm"' in line)
    assert 'src/server/router.ts' in confirm_line
    assert 'src/server/router.ts' in prompts[1]
    assert 'Path corrected' in prompts[1]
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@patch('clara_coder_backend.plan.plan_execute.await_question_answers')
def test_stream_plan_execute_ambiguous_path_asks_then_applies_without_replan(
    mock_question_pause: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    for folder in ('api', 'web'):
        (tmp_path / folder).mkdir()
        (tmp_path / folder / 'router.ts').write_text('', encoding='utf-8')
    mock_planner.side_effect = _planner_md_for('src/router.ts')
    prompts: list[str] = []
    mock_exec.side_effect = _two_run_exec(prompts)
    mock_pause.return_value = None
    asked: list[dict[str, Any]] = []

    async def _answer(sid: str) -> list[dict[str, Any]]:
        pending = get_session(sid).pending_question_request
        asked.extend(pending['questions'])
        q = pending['questions'][0]
        web = next(o for o in q['options'] if o['label'] == 'web/router.ts')
        return [{'question_id': q['id'], 'option_id': web['id'], 'other_text': None}]

    mock_question_pause.side_effect = _answer
    outcome = LangGraphWorkerOutcome()
    lines = _run_plan(SessionState(workspace_path=str(tmp_path)), 'sess-path-ambiguous', outcome)

    assert {o['label'] for o in asked[0]['options']} == {'api/router.ts', 'web/router.ts'}
    # One planner pass and no follow-up discovery: the answer is applied directly.
    assert mock_planner.call_count == 1
    assert len(prompts) == 2
    assert not any('Rewriting plan' in line for line in lines)
    assert 'web/router.ts' in prompts[1]
    assert outcome.state == AgentLoopOutcome.COMPLETED


@patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent')
@patch('clara_coder_backend.plan.plan_execute._stream_planner_md')
@patch('clara_coder_backend.plan.plan_execute.await_diff_review_note')
@patch('clara_coder_backend.plan.plan_execute.await_question_answers')
def test_stream_plan_execute_missing_file_clarify_stops_planning(
    mock_question_pause: AsyncMock,
    mock_pause: AsyncMock,
    mock_planner: AsyncMock,
    mock_exec: AsyncMock,
    tmp_path: Path,
) -> None:
    mock_planner.side_effect = _planner_md_for('src/router.ts')
    prompts: list[str] = []
    mock_exec.side_effect = _two_run_exec(prompts)
    mock_question_pause.return_value = [
        {'question_id': 'q-path-1', 'option_id': 'q-path-1-opt-2', 'other_text': None},
    ]
    mock_pause.return_value = None

    outcome = LangGraphWorkerOutcome()
    lines = _run_plan(SessionState(workspace_path=str(tmp_path)), 'sess-path-clarify', outcome)

    assert sum('"type": "agent_question"' in line for line in lines) == 1
    assert not any('"type": "plan_confirm"' in line for line in lines)
    assert len(prompts) == 1
    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert 'src/router.ts' in (outcome.final_text or '')


def test_triage_drops_file_fact_and_duplicate_questions_and_caps_the_rest() -> None:
    from clara_coder_backend.plan.plan_execute import MAX_OPEN_QUESTIONS, _triage_planner_questions

    design = [
        OpenQuestion(id=f'q-{i}', prompt=f'Design choice {i}?', options=[f'A{i}', f'B{i}'])
        for i in range(MAX_OPEN_QUESTIONS + 1)
    ]
    plan = BuildPlanModel(
        title='T',
        task='T',
        current_implementation='',
        open_questions=[
            OpenQuestion(id='q-x', prompt='Does src/ui/inventoryUI.ts exist?', options=['Yes', 'No']),
            design[0],
            OpenQuestion(id='q-dup', prompt='design choice 0?', options=['A', 'B']),
            *design[1:],
        ],
        action_steps=[ActionStep(id='step-1', goal='Work')],
    )
    defaults = _triage_planner_questions(plan)
    assert [q.id for q in plan.open_questions] == [q.id for q in design[:MAX_OPEN_QUESTIONS]]
    assert defaults == [f'Design choice {MAX_OPEN_QUESTIONS}? → A{MAX_OPEN_QUESTIONS} (default; not asked)']


def test_planner_guidelines_forbid_file_existence_questions() -> None:
    from clara_coder_backend.plan.plan_execute import PLAN_AUTHORING_GUIDELINES

    assert 'never ask the user whether a file exists' in PLAN_AUTHORING_GUIDELINES
    assert 'no backticks' in PLAN_AUTHORING_GUIDELINES
