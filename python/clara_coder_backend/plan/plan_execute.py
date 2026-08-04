"""Plan-and-execute orchestrator (LangGraph tutorial control flow, nemo streaming/HITL).

Read-only discovery (:mod:`clara_coder_backend.plan.plan_discovery`) runs before planning; the planner
proposes a structured build plan written to ``.nemo/build-plans/``; user approves via
:mod:`clara_coder_backend.plan.plan_confirm`; a single ReAct executor run implements the plan using
:mod:`clara_coder_backend.plan.build_plan_tools` to mark milestones.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import AIMessageChunk, HumanMessage
from langchain_core.prompts import ChatPromptTemplate

from clara_coder_backend.lang_agent.graph import AgentGraphConfig, _stream_langgraph_tool_agent, build_clara_single_outer_graph
from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.session.pause import await_diff_review_note, await_question_answers
from clara_coder_backend.lang_agent.question import (
    agent_question_sse_payload,
    stage_question_request,
)
from clara_coder_backend.lang_agent.streaming import (
    agent_question_event,
    aimessage_chunk_reasoning_delta,
    aimessage_chunk_sse_delta,
    build_plan_chunk_event,
    build_plan_open_event,
    build_plan_stream_end_event,
    is_meaningful_stream_delta,
    model_chunk_sse_line,
    planner_progress_event,
    plan_confirm_event,
    sse_line,
    status_event,
)
from clara_coder_backend.plan.build_plan_store import (
    ActionStep,
    BuildPlanModel,
    BuildPlanRecord,
    FileChangeEntry,
    OpenQuestion,
    cancel_build_plan,
    complete_build_plan,
    create_build_plan_draft,
    finalize_build_plan_draft,
    parse_build_plan_md,
    planner_progress_payload_from_parsed,
    read_build_plan_md,
    render_build_plan_md,
    set_build_plan_status,
    write_build_plan_draft_content,
)
from clara_coder_backend.hitl.deferred_tool_hitl import deferred_tool_hitl_bypass
from clara_coder_backend.domain import SessionState
from clara_coder_backend.llm.factory import build_llm
from clara_coder_backend.logging.llm_interaction_logging import log_llm_failure
from clara_coder_backend.llm.messages import build_system_prompt, stringify_content
from clara_coder_backend.plan.plan_confirm import plan_confirm_sse_payload, stage_plan_confirm_request
from clara_coder_backend.plan.plan_discovery import (
    PLAN_DISCOVERY_EXECUTE_LABEL,
    build_freeform_discovery_prompt,
)
from clara_coder_backend.stream_tags import PLANNER_STREAM_TAG, REASONING_AUXILIARY_STREAM_TAG
from clara_coder_backend.hitl.tool_registry import format_tools_catalog
from clara_coder_backend.plan.plan_tools_registry import plan_execute_tools_and_map
from clara_coder_backend.tools.workspace import truncate_text

logger = logging.getLogger('clara.plan_execute')

RECORD_PLAN_LABEL = 'record_plan'
EXECUTE_BUILD_PLAN_LABEL = 'execute_build_plan'

# Plan mode always binds the full outer-agent tool surface (staging, transfer, deps, tests, …)
# regardless of the toolbar Editor toggle for this HTTP request.
PLAN_EXECUTE_APPLY_MODE = True

PLAN_MARKDOWN_TEMPLATE_EXAMPLE = render_build_plan_md(
    BuildPlanModel(
        title='Short title',
        task='User goal in plain language.',
        current_implementation='Relevant existing behavior from discovery.',
        files_to_change=[
            FileChangeEntry(
                path='src/example.ts',
                operation='modify',
                rationale='brief rationale',
            )
        ],
        assumptions=['Assumption the planner made, stated explicitly.'],
        open_questions=[
            {
                'id': 'q-1',
                'prompt': 'A clarifying question only the user can answer?',
                'options': ['First suggested answer', 'Second suggested answer'],
            }
        ],
        rollback_notes='How to revert these changes if needed.',
        definition_of_done=['Plan-level outcome that proves the objective is met.'],
        action_steps=[
            ActionStep(
                id='step-1',
                goal='First milestone',
                files_touched=['src/example.ts'],
                approach='Brief description of how to implement it.',
                acceptance_criteria=['Checkable outcome that proves this step is done.'],
                verification='Command or check to run (e.g. `pytest tests/x`).',
                risks=['Risk or caveat for this step.'],
            ),
            ActionStep(id='step-2', goal='Second milestone'),
        ],
    )
)

PLAN_AUTHORING_GUIDELINES = (
    'Plan authoring guidelines (apply to every build plan):\n'
    '- Grounding: every modify/delete files_to_change entry must be justified by a concrete discovery '
    'finding (a path, symbol, or pattern you observed). Create entries may use new paths, but the '
    'parent directory or related existing code must still be grounded in discovery. If you cannot '
    'ground an entry, do not invent it — surface the gap as an open_question instead.\n'
    '- File operations: include creates, modifies, and deletes in files_to_change. Set operation to '
    'create, modify, or delete for each entry; do not omit deletes or new files.\n'
    '- Granularity: use coarse-grained milestones — roughly one major outcome per action step. '
    'Do not bundle unrelated changes in one step, and do not add superfluous steps.\n'
    '- Verifiability: every action step must have checkable acceptance_criteria and a verification '
    'command or check (e.g. `pytest tests/x`, `npm run build`, a smoke request). A step is done only '
    'when its acceptance criteria are met.\n'
    '- File mapping: list the files each step creates, modifies, or deletes in that step\'s '
    'files_touched. Keep files_to_change as the plan-level summary with operation and rationale.\n'
    '- No discovery as action steps: discovery already ran. Do not add steps whose primary purpose is '
    'read-only exploration (search, inspect, read files, semantic lookup, "understand the codebase").\n'
    '- Risks: call out per-step risks (shared code, migrations, dep changes, breaking changes). At the '
    'plan level, set rollback_notes describing how to revert.\n'
    '- Assumptions: record assumptions explicitly in the assumptions section so the user can challenge them.\n'
    '- Open questions: only include questions that genuinely block the plan and that only the user can '
    'answer. Provide 2-4 concrete suggested options per question. If you have enough context to proceed, '
    'omit open_questions entirely.\n'
    '- Definition of done: list plan-level outcomes that prove the whole objective is met.\n'
    '- Completion: the final action step must validate the whole objective (run the test suite / smoke check).'
)

PLAN_MARKDOWN_STREAM_INSTRUCTIONS = (
    'You are in plan mode. Output ONLY the build-plan Markdown document (no preamble or commentary).\n'
    'Do NOT emit tool calls, <tool_call> XML, pseudo-tool tags, or function calls — you have no '
    'tools in this phase and any tool invocation is ignored. Start the document with `# Build Plan:` '
    'and write the plan from the discovery context provided.\n'
    'Use this exact structure:\n\n'
    f'{PLAN_MARKDOWN_TEMPLATE_EXAMPLE}\n'
    f'{PLAN_AUTHORING_GUIDELINES}\n'
    'Markdown rules:\n'
    '- Replace placeholder content with facts grounded in discovery.\n'
    '- Include `<!-- step-id: step-N -->` immediately before each `- [ ]` action step line.\n'
    '- Nest per-step details (Files, Approach, Acceptance criteria, Verification, Risks) as indented '
    '`- **Key:**` bullets under each step checkbox. Put acceptance criteria and risks items as '
    '4-space-indented `- item` sub-bullets.\n'
    '- Mark each open question with `<!-- q-id: q-N -->` and list its suggested options as indented bullets.\n'
    '- Omit any section that has no content (do not emit empty headers).'
)

PLAN_DRAFTING_OVERRIDE = (
    'Plan drafting override (for initial plan only — supersedes general inspect-first guidance above):\n'
    '- Read-only discovery already completed in a prior phase; do not plan exploration steps.\n'
    '- Plan only work the executor should mutate or deliver.'
)

PLAN_DRAFT_DISK_WRITE_INTERVAL_SEC = 0.5


def build_planner_context_block(
    session: SessionState,
    apply_mode: bool,
    *,
    for_initial_plan: bool = False,
    with_tools_catalog: bool = True,
) -> str:
    """System prompt + tool catalog shared by the planner (matches executor bindings).

    ``with_tools_catalog=False`` is used by the markdown-streaming planner phase, which has no
    tool channel bound. Advertising tools there makes tool-happy local models emit
    ``<tool_call>`` XML as plain text instead of the plan document, so the catalog is omitted and
    tool invocations are explicitly forbidden.
    """
    system_prompt = build_system_prompt(session, apply_mode)
    override = f'{PLAN_DRAFTING_OVERRIDE}\n\n' if for_initial_plan else ''
    if with_tools_catalog:
        tools, _ = plan_execute_tools_and_map(apply_mode, session=session)
        catalog = format_tools_catalog(tools)
        return (
            f'{system_prompt}\n\n'
            f'{override}'
            'Available tools (same bindings the executor will use):\n'
            f'{catalog}'
        )
    return (
        f'{system_prompt}\n\n'
        f'{override}'
        'You have NO tools in this phase and cannot call any tool. Do not emit <tool_call>, '
        'function-call XML, pseudo-tool tags (e.g. <read_workspace_file>), or any tool '
        'invocation — there is no tool channel here, so any such output is ignored. Read-only '
        'discovery already ran; write the build-plan Markdown document from the provided '
        'discovery context alone.\n'
    )


def _build_discovery_preamble(discovery_summary: str) -> str:
    summary = (discovery_summary or '').strip()
    if summary:
        findings = (
            'Discovery has already run. Findings (authoritative — ground the plan in these facts):\n'
            f'{summary}'
        )
    else:
        findings = (
            'Discovery has already run in a prior phase and produced no additional findings beyond '
            'the workspace context above.'
        )
    return (
        f'\n\n{findings}\n\n'
        'Do not add action steps whose only purpose is read-only discovery (search, explore, inspect, '
        'locate, read files, semantic lookup, or "understand the codebase"). '
        'Assume sufficient context exists to start implementation.'
    )


def _escape_prompt_template_braces(text: str) -> str:
    """Escape literal ``{``/``}`` so dynamic context is not parsed as template variables."""
    return text.replace('{', '{{').replace('}', '}}')


def _resolved_answers_preamble(resolved_answers: str) -> str:
    """Format user answers to open questions for injection into the refinement prompt."""
    text = (resolved_answers or '').strip()
    if not text:
        return ''
    return (
        f'\n\nResolved clarifying questions (authoritative — incorporate into the plan):\n'
        f'{text}\n'
    )


def _grounding_gap_questions(plan_model: BuildPlanModel, discovery_summary: str) -> list[OpenQuestion]:
    """Surface open questions for modify/delete files_to_change entries not grounded by discovery.

    Lightweight LLM-free heuristic: an entry is grounded when its path (or basename) appears in the
    discovery summary. Create entries are skipped (new paths will not appear in discovery).
    Ungrounded modify/delete entries become a yes/no open question so the user can confirm the
    planner should proceed despite the gap.
    """
    summary = (discovery_summary or '').strip()
    if not summary:
        return []
    gaps: list[OpenQuestion] = []
    summary_lower = summary.lower()
    for entry in plan_model.files_to_change or []:
        path = str(getattr(entry, 'path', '') or '').strip()
        operation = str(getattr(entry, 'operation', 'modify') or 'modify').strip().lower()
        if not path or operation == 'create':
            continue
        basename = path.rsplit('/', 1)[-1].rsplit('\\', 1)[-1].strip().lower()
        path_lower = path.lower()
        if path_lower and path_lower in summary_lower:
            continue
        if basename and basename in summary_lower:
            continue
        if operation == 'delete':
            prompt = (
                f'Discovery did not confirm the path "{path}". Should I proceed assuming it exists '
                f'and is safe to delete?'
            )
        else:
            prompt = (
                f'Discovery did not confirm the path "{path}". Should I proceed assuming it exists '
                f'and is the right place to make this change?'
            )
        gaps.append(
            OpenQuestion(
                id=f'q-ground-{len(gaps) + 1}',
                prompt=prompt,
                options=['Proceed with the assumption', 'Cancel and let me clarify'],
            )
        )
    return gaps


def _answer_text(question: OpenQuestion, answer: dict[str, Any]) -> str:
    """Resolve one answer to display text (free-text wins over option id)."""
    other = str(answer.get('other_text') or '').strip()
    if other:
        return other
    option_id = str(answer.get('option_id') or '').strip()
    if option_id:
        # option ids are formatted as "{qid}-opt-{N}"; map back to the option label.
        suffix = option_id.rsplit('-opt-', 1)[-1]
        try:
            index = int(suffix) - 1
        except ValueError:
            return option_id
        if 0 <= index < len(question.options):
            return str(question.options[index]).strip()
    return ''


def _format_resolved_answers(
    open_questions: list[OpenQuestion], answers: list[dict[str, Any]]
) -> str:
    """Build a Q&A block string for injection into the refinement planner prompt."""
    by_qid = {str(a.get('question_id') or '').strip(): a for a in answers}
    lines: list[str] = []
    for q in open_questions:
        answer = by_qid.get(q.id.strip())
        if not answer:
            continue
        text = _answer_text(q, answer)
        if not text:
            continue
        lines.append(f'Q: {q.prompt}\nA: {text}')
    return '\n'.join(lines)


def _resolved_questions_for_confirm(
    open_questions: list[OpenQuestion], answers: list[dict[str, Any]]
) -> list[dict[str, str]]:
    """Shape resolved Q&A pairs for the enriched plan_confirm payload."""
    by_qid = {str(a.get('question_id') or '').strip(): a for a in answers}
    out: list[dict[str, str]] = []
    for q in open_questions:
        answer = by_qid.get(q.id.strip())
        if not answer:
            continue
        text = _answer_text(q, answer)
        if not text:
            continue
        out.append({'prompt': q.prompt, 'answer': text})
    return out


def _planner_markdown_chain(planner_context: str, *, discovery_summary: str = ''):
    discovery_block = _build_discovery_preamble(discovery_summary)
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                f'{_escape_prompt_template_braces(planner_context)}'
                f'{_escape_prompt_template_braces(discovery_block)}\n\n'
                f'{_escape_prompt_template_braces(PLAN_MARKDOWN_STREAM_INSTRUCTIONS)}',
            ),
            ('placeholder', '{messages}'),
        ]
    )
    return prompt | build_llm()


def _planner_chain(planner_context: str, *, discovery_summary: str = '', resolved_answers: str = ''):
    discovery_block = _build_discovery_preamble(discovery_summary)
    answers_block = _resolved_answers_preamble(resolved_answers)
    refinement_directive = (
        '\n\nYou are producing the FINAL build plan after the user answered clarifying questions. '
        'Incorporate the resolved answers below into the plan; do not emit an Open Questions section.\n'
        if resolved_answers
        else ''
    )
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                f'{_escape_prompt_template_braces(planner_context)}'
                f'{_escape_prompt_template_braces(discovery_block)}'
                f'{_escape_prompt_template_braces(answers_block)}'
                f'{_escape_prompt_template_braces(refinement_directive)}\n\n'
                'You are in plan mode. Produce a build plan as a structured object with these fields:\n'
                '- title: short document title\n'
                '- task: user goal in plain language\n'
                '- current_implementation: relevant existing behavior from discovery\n'
                '- files_to_change: list of objects (path, operation create|modify|delete, rationale)\n'
                '- assumptions: explicit assumptions the planner made\n'
                '- open_questions: list of objects (id, prompt, options list) — only questions that block '
                'the plan and only the user can answer; empty if you have enough context\n'
                '- rollback_notes: how to revert the changes\n'
                '- definition_of_done: plan-level outcomes that prove the objective is met\n'
                '- action_steps: list of objects (id, goal, files_touched list, approach, '
                'acceptance_criteria list, verification, risks list) — ordered, verifiable milestones '
                '(mutating/delivering work only)\n\n'
                f'{_escape_prompt_template_braces(PLAN_AUTHORING_GUIDELINES)}',
            ),
            ('placeholder', '{messages}'),
        ]
    )
    return prompt | build_llm().with_structured_output(BuildPlanModel)


def _planner_progress_payload(
    *,
    phase: str,
    steps: list[dict[str, Any]],
    plan_ready: bool = False,
    active_step_id: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        'streamTag': PLANNER_STREAM_TAG,
        'phase': phase,
        'planReady': plan_ready,
        'steps': steps,
    }
    if active_step_id:
        payload['activeStepId'] = active_step_id
    return payload


def _steps_from_texts(
    texts: list[str],
    *,
    states: list[str] | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, text in enumerate(texts):
        state = states[i] if states and i < len(states) else 'pending'
        out.append({'id': f'step-{i + 1}', 'text': text.strip(), 'state': state})
    return out


def build_build_plan_executor_prompt(build_plan_path: str) -> str:
    """User message for the single non-sequential plan executor run."""

    path = (build_plan_path or '').strip() or '.nemo/build-plans/active-plan.md'
    return (
        f'Implement the build plan at `{path}`.\n\n'
        'Work at your own pace — action steps need not be completed in strict order. '
        'Use `read_build_plan` whenever you need the latest plan text. '
        'When you finish one or more milestones, call `mark_build_plan_steps_complete` with their '
        'step ids (for example `step-1`); you may pass multiple ids in one call. '
        'Do not wait for step order before marking progress.\n\n'
        'When all action steps are done, summarize what you accomplished.'
    )


def emit_planner_progress_from_md(session: SessionState, *, phase: str = 'executing') -> None:
    """Push ``planner_progress`` onto the nested SSE queue (callable from sync tools)."""
    import asyncio

    from clara_coder_backend.plan.build_plan_store import parse_action_steps, read_build_plan_text

    try:
        md = read_build_plan_text(session)
        parsed = parse_action_steps(md)
    except (FileNotFoundError, OSError):
        return
    payload = planner_progress_payload_from_parsed(parsed, phase=phase)
    queue = session.planning_nested_events_q
    if queue is None:
        return
    try:
        queue.put_nowait(('planner', {'event': 'planner_progress', 'data': {'planner': payload}}))
    except asyncio.QueueFull:
        pass


def _plan_execute_outer_graph_builder(
    llm: Any,
    session: SessionState,
    apply_mode: bool,
    extra_middleware: list[Any] | None,
) -> Any:
    return build_clara_single_outer_graph(
        llm,
        session,
        apply_mode,
        extra_middleware=extra_middleware,
        tools_provider=plan_execute_tools_and_map,
    )


async def _stream_planner_md(
    user_input: str,
    *,
    session: SessionState,
    apply_mode: bool,
    discovery_summary: str,
    record: BuildPlanRecord,
    md_out: list[str],
) -> AsyncIterator[str]:
    """Stream planner markdown into SSE chunks and throttled disk writes.

    The markdown phase has no tool channel, so the planner context omits the tool catalog and
    forbids tool invocations. If the model still emits a tool call / non-plan output instead of
    a ``# Build Plan`` document, retry once — local tool-happy models occasionally need a re-roll.
    """

    accumulated = ''
    last_disk_write = 0.0
    workspace_root = (session.workspace_path or '').strip()
    relative_path = record.relative_path

    for attempt in range(2):
        accumulated = ''
        last_disk_write = 0.0
        chain = _planner_markdown_chain(
            build_planner_context_block(
                session,
                apply_mode,
                for_initial_plan=True,
                with_tools_catalog=False,
            ),
            discovery_summary=discovery_summary,
        )
        async for chunk in chain.astream({'messages': [HumanMessage(content=user_input)]}):
            if session.abort_event.is_set():
                md_out.clear()
                md_out.append('')
                return
            if not isinstance(chunk, AIMessageChunk):
                continue
            # Mirror langgraph_sse: main deltas draft the build plan; reasoning goes to the
            # chat auxiliary trail (overflow reveal / autoscroll) like agent mode.
            reason_delta = aimessage_chunk_reasoning_delta(chunk)
            if is_meaningful_stream_delta(reason_delta):
                yield model_chunk_sse_line(reason_delta, REASONING_AUXILIARY_STREAM_TAG)
            delta = aimessage_chunk_sse_delta(chunk)
            if not is_meaningful_stream_delta(delta):
                continue
            accumulated += delta
            yield sse_line(build_plan_chunk_event(relative_path=relative_path, content=accumulated))
            now = time.monotonic()
            if workspace_root and now - last_disk_write >= PLAN_DRAFT_DISK_WRITE_INTERVAL_SEC:
                write_build_plan_draft_content(workspace_root, record, accumulated)
                last_disk_write = now

        if workspace_root and accumulated:
            write_build_plan_draft_content(workspace_root, record, accumulated)

        # Accept the stream if it produced a real plan document; otherwise retry once when the
        # model emitted a tool call / garbage instead of markdown.
        if '# Build Plan' in accumulated or not accumulated.strip():
            break
        if attempt == 0:
            logger.warning(
                'Planner emitted non-plan output for %s (len=%d); retrying once. Tail: %r',
                relative_path,
                len(accumulated),
                accumulated[-400:],
            )
            # Clear the preview so the retry's first chunk doesn't append to the garbage.
            yield sse_line(build_plan_chunk_event(relative_path=relative_path, content=''))

    md_out.clear()
    md_out.append(accumulated)

    # Surface empty / truncated planner output so the cause isn't erased when the caller
    # discards the draft. A missing "## Action Steps" header usually means the model hit a
    # token cap mid-document; empty content means the chat model returned nothing parseable
    # (e.g. a reasoning model that streamed everything into a reasoning channel).
    if not accumulated.strip():
        logger.warning('Planner markdown stream produced no content for %s', relative_path)
    elif '## Action Steps' not in accumulated:
        logger.warning(
            'Planner markdown for %s has no "## Action Steps" section (likely truncated; '
            'len=%d). Tail: %r',
            relative_path,
            len(accumulated),
            accumulated[-400:],
        )
    else:
        logger.info('Planner markdown stream finished for %s (len=%d)', relative_path, len(accumulated))


async def _invoke_planner(
    user_input: str,
    *,
    session: SessionState,
    apply_mode: bool,
    discovery_summary: str = '',
    resolved_answers: str = '',
    for_initial_plan: bool = True,
) -> BuildPlanModel:
    chain = _planner_chain(
        build_planner_context_block(session, apply_mode, for_initial_plan=for_initial_plan),
        discovery_summary=discovery_summary,
        resolved_answers=resolved_answers,
    )
    return await chain.ainvoke({'messages': [HumanMessage(content=user_input)]})


async def _stream_plan_discovery_phase(
    session: SessionState,
    user_input: str,
    *,
    session_id: str,
    summary_out: list[str],
) -> AsyncIterator[str]:
    """Run a single free-form read-only discovery pass before planning."""

    yield sse_line(
        planner_progress_event(
            _planner_progress_payload(phase='discovery', steps=[], plan_ready=False),
        )
    )

    if session.abort_event.is_set():
        summary_out.clear()
        summary_out.append('')
        return

    exec_status_id = f'plan-disc-{uuid.uuid4().hex[:10]}'
    yield sse_line(
        status_event(
            exec_status_id,
            PLAN_DISCOVERY_EXECUTE_LABEL,
            detail='Exploring the workspace (read-only).',
            state='running',
            source='tool',
            stream_tag=PLANNER_STREAM_TAG,
        )
    )

    discovery_prompt = build_freeform_discovery_prompt(user_input)
    discover_outcome = LangGraphWorkerOutcome()
    discover_cfg = AgentGraphConfig(
        session_id=session_id,
        checkpoint_session_key=f'{session_id}:plan_discover',
        graph_name='plan_discover',
        agent_role=None,
        status_label='Discover',
        llm_event_prefix='discover',
        config_error_event_id='plan-discover-graph',
        run_error_event_id='plan-discover-graph-error',
        done_event_id='plan-discover-done',
        empty_final_user_hint='Discovery finished without a summary.',
        failed_start_message='Discovery failed: {exc}',
        failed_run_message='Discovery error: {exc}',
        thread_kind='plan_discover',
        done_detail='Discovery complete',
    )

    hitl_bypass_token = deferred_tool_hitl_bypass.set(True)
    try:
        async for line in _stream_langgraph_tool_agent(
            session,
            False,
            discovery_prompt,
            cfg=discover_cfg,
            outcome=discover_outcome,
        ):
            if session.abort_event.is_set():
                discover_outcome.mark_aborted()
                break
            yield line
    finally:
        deferred_tool_hitl_bypass.reset(hitl_bypass_token)

    executor_summary = discover_outcome.best_available_text()
    exec_ok = discover_outcome.state == AgentLoopOutcome.COMPLETED
    yield sse_line(
        status_event(
            exec_status_id,
            PLAN_DISCOVERY_EXECUTE_LABEL,
            detail=truncate_text(executor_summary or 'Discovery complete.', 200),
            state='complete' if exec_ok else 'error',
            source='tool',
            stream_tag=PLANNER_STREAM_TAG,
        )
    )

    summary_out.clear()
    summary_out.append(executor_summary.strip() if executor_summary else '')


async def stream_plan_execute_langgraph(
    session: SessionState,
    user_message: str | list[dict[str, Any]],
    apply_mode: bool,
    *,
    session_id: str,
    outcome: LangGraphWorkerOutcome,
) -> AsyncIterator[str]:
    """Run plan-and-execute: discovery, build-plan MD, HITL confirm, single executor run."""

    user_input = stringify_content(user_message).strip()
    if not user_input:
        user_input = '(multimodal turn)'

    tool_apply_mode = PLAN_EXECUTE_APPLY_MODE

    cfg = AgentGraphConfig(
        session_id=session_id,
        graph_name='nemo_plan',
        agent_role=None,
        status_label='Plan',
        llm_event_prefix='plan',
        config_error_event_id='plan-graph',
        run_error_event_id='plan-graph-error',
        done_event_id='plan-done',
        empty_final_user_hint='The planner finished without a final text response.',
        failed_start_message='Plan mode failed to start: {exc}',
        failed_run_message='Plan mode error: {exc}',
        thread_kind='plan',
        done_detail='Complete',
    )

    try:
        discovery_summary_box: list[str] = ['']
        async for line in _stream_plan_discovery_phase(
            session,
            user_input,
            session_id=session_id,
            summary_out=discovery_summary_box,
        ):
            if session.abort_event.is_set():
                outcome.mark_aborted()
                return
            yield line
        discovery_summary = discovery_summary_box[0] if discovery_summary_box else ''
    except Exception as exc:
        logger.exception('Plan mode discovery failed')
        log_llm_failure(exc, context='plan:discovery', agent_role=None)
        yield sse_line(
            status_event(
                'plan-discovery-error',
                'Discovery failed',
                detail=str(exc).replace('\n', ' ')[:200],
                state='error',
                stream_tag=PLANNER_STREAM_TAG,
            )
        )
        outcome.mark_failed_runtime(str(exc), final_text=cfg.failed_run_message.format(exc=exc))
        return

    if not (session.workspace_path or '').strip():
        outcome.mark_failed_runtime(
            'missing workspace',
            final_text='Attach a workspace before running plan mode.',
        )
        yield sse_line(
            status_event(
                'plan-no-workspace',
                'Planning',
                detail='No workspace attached.',
                state='error',
                stream_tag=PLANNER_STREAM_TAG,
            )
        )
        return

    try:
        record = create_build_plan_draft(
            session.workspace_path,
            session_id,
            session=session,
        )
    except Exception as exc:
        logger.exception('Build plan draft creation failed')
        outcome.mark_failed_runtime(str(exc), final_text=cfg.failed_run_message.format(exc=exc))
        return

    yield sse_line(
        planner_progress_event(
            _planner_progress_payload(phase='planning', steps=[], plan_ready=False),
        )
    )
    yield sse_line(
        build_plan_open_event(
            {
                'planId': record.id,
                'relativePath': record.relative_path,
                'title': 'Build plan',
                'previewMode': True,
            }
        )
    )

    md_box: list[str] = ['']
    try:
        async for line in _stream_planner_md(
            user_input,
            session=session,
            apply_mode=tool_apply_mode,
            discovery_summary=discovery_summary,
            record=record,
            md_out=md_box,
        ):
            if session.abort_event.is_set():
                outcome.mark_aborted()
                return
            yield line
    except Exception as exc:
        logger.exception('Plan mode planner failed')
        log_llm_failure(exc, context='plan:planner', agent_role=None)
        cancel_build_plan(session, record.id)
        yield sse_line(
            status_event(
                'plan-planner-error',
                'Planning failed',
                detail=str(exc).replace('\n', ' ')[:200],
                state='error',
                stream_tag=PLANNER_STREAM_TAG,
            )
        )
        outcome.mark_failed_runtime(str(exc), final_text=cfg.failed_run_message.format(exc=exc))
        return

    if session.abort_event.is_set():
        outcome.mark_aborted()
        return

    md_text = md_box[0] if md_box else ''
    try:
        plan_model = parse_build_plan_md(md_text)
        grounding_gaps = _grounding_gap_questions(plan_model, discovery_summary)
        if grounding_gaps:
            plan_model.open_questions = list(plan_model.open_questions) + grounding_gaps
        record = finalize_build_plan_draft(session.workspace_path, record, md_text)
    except Exception as exc:
        logger.exception('Build plan finalize failed')
        cancel_build_plan(session, record.id)
        yield sse_line(
            status_event(
                'plan-planner-error',
                'Planning failed',
                detail=str(exc).replace('\n', ' ')[:200],
                state='error',
                stream_tag=PLANNER_STREAM_TAG,
            )
        )
        outcome.mark_failed_runtime(str(exc), final_text=cfg.failed_run_message.format(exc=exc))
        return

    yield sse_line(build_plan_stream_end_event(relative_path=record.relative_path))

    # Open-questions HITL: ask the user, then refine the plan with the resolved answers.
    resolved_questions: list[dict[str, str]] = []
    if plan_model.open_questions:
        # Show the draft steps in the plan panel while the user answers questions.
        draft_step_goals = [s.goal.strip() for s in plan_model.action_steps if s.goal.strip()]
        draft_step_rows = _steps_from_texts(draft_step_goals)
        yield sse_line(
            planner_progress_event(
                _planner_progress_payload(phase='planning', steps=draft_step_rows, plan_ready=True),
            )
        )
        question_pending = stage_question_request(
            session,
            questions=[
                {'id': q.id, 'prompt': q.prompt, 'options': list(q.options)}
                for q in plan_model.open_questions
            ],
            build_plan_id=record.id,
            build_plan_path=record.relative_path,
        )
        yield sse_line(agent_question_event(agent_question_sse_payload(question_pending)))
        await await_question_answers(session_id)
        if session.question_aborted or session.abort_event.is_set():
            cancel_build_plan(session, record.id)
            outcome.mark_aborted()
            return
        answers = list(session.question_answers or [])
        session.question_answers = None
        resolved_questions = _resolved_questions_for_confirm(plan_model.open_questions, answers)
        resolved_answers_text = _format_resolved_answers(plan_model.open_questions, answers)
        try:
            refined = await _invoke_planner(
                user_input,
                session=session,
                apply_mode=tool_apply_mode,
                discovery_summary=discovery_summary,
                resolved_answers=resolved_answers_text,
                for_initial_plan=False,
            )
        except Exception as exc:
            logger.exception('Plan refinement failed')
            log_llm_failure(exc, context='plan:refine', agent_role=None)
            cancel_build_plan(session, record.id)
            yield sse_line(
                status_event(
                    'plan-refine-error',
                    'Planning failed',
                    detail=str(exc).replace('\n', ' ')[:200],
                    state='error',
                    stream_tag=PLANNER_STREAM_TAG,
                )
            )
            outcome.mark_failed_runtime(str(exc), final_text=cfg.failed_run_message.format(exc=exc))
            return
        refined_md = render_build_plan_md(refined)
        write_build_plan_draft_content(session.workspace_path, record, refined_md)
        record = finalize_build_plan_draft(session.workspace_path, record, refined_md)
        plan_model = parse_build_plan_md(refined_md)
        # Refresh the preview tab with the finalized plan.
        yield sse_line(build_plan_chunk_event(relative_path=record.relative_path, content=refined_md))
        yield sse_line(build_plan_stream_end_event(relative_path=record.relative_path))

    action_step_goals = [s.goal.strip() for s in plan_model.action_steps if s.goal.strip()]
    if not action_step_goals:
        # Preserve the draft file so the user can see what the planner actually emitted
        # (often a plan truncated mid-document by a token cap, or content the parser couldn't
        # turn into checkboxes). Deleting it here destroys the only evidence of why planning
        # failed. Mark it cancelled so it stops being the session's active plan.
        try:
            draft_md = read_build_plan_md(session.workspace_path, record)
        except OSError:
            draft_md = ''
        logger.warning(
            'Plan parsed with no action steps; preserving draft at %s (md_len=%d, '
            'open_questions=%d). Excerpt: %r',
            record.relative_path,
            len(draft_md),
            len(plan_model.open_questions or []),
            draft_md[:800],
        )
        set_build_plan_status(session, record.id, 'cancelled')
        session.active_build_plan_id = ''
        session.active_build_plan_path = ''
        outcome.mark_completed(
            final_text=(
                'The planner did not produce any action steps, so the plan was not run. '
                'The draft was kept at .nemo/build-plans/ — open it to see what the planner '
                'generated (it may have been cut off mid-document).'
            ),
        )
        yield sse_line(
            status_event(
                'plan-empty',
                'Planning',
                detail='No action steps generated — draft kept for inspection.',
                state='error',
                stream_tag=PLANNER_STREAM_TAG,
            )
        )
        return

    record_plan_id = f'plan-record-{uuid.uuid4().hex[:10]}'
    yield sse_line(
        status_event(
            record_plan_id,
            RECORD_PLAN_LABEL,
            detail=f'Build plan "{record.title}" ready for review.',
            state='complete',
            source='tool',
            stream_tag=PLANNER_STREAM_TAG,
        )
    )

    step_rows = _steps_from_texts(action_step_goals)
    yield sse_line(
        planner_progress_event(
            _planner_progress_payload(phase='planning', steps=step_rows, plan_ready=True),
        )
    )

    all_risks = [r for step in plan_model.action_steps for r in step.risks if r.strip()]
    pending = stage_plan_confirm_request(
        session,
        steps=action_step_goals,
        build_plan_id=record.id,
        build_plan_path=record.relative_path,
        files_to_change=list(plan_model.files_to_change),
        current_implementation=plan_model.current_implementation,
        risks=all_risks,
        definition_of_done=list(plan_model.definition_of_done),
        resolved_questions=resolved_questions,
    )
    yield sse_line(plan_confirm_event(plan_confirm_sse_payload(pending)))
    await await_diff_review_note(session_id)

    if session.plan_execute_aborted or session.abort_event.is_set():
        outcome.mark_aborted()
        return

    yield sse_line(
        planner_progress_event(
            _planner_progress_payload(phase='executing', steps=step_rows),
        )
    )

    exec_status_id = f'plan-exec-{uuid.uuid4().hex[:10]}'
    yield sse_line(
        status_event(
            exec_status_id,
            EXECUTE_BUILD_PLAN_LABEL,
            detail=truncate_text(record.title, 200),
            state='running',
            source='tool',
            stream_tag=PLANNER_STREAM_TAG,
        )
    )

    exec_prompt = build_build_plan_executor_prompt(session.active_build_plan_path)
    exec_outcome = LangGraphWorkerOutcome()
    exec_cfg = AgentGraphConfig(
        session_id=session_id,
        checkpoint_session_key=f'{session_id}:plan_exec',
        graph_name='plan_exec',
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        config_error_event_id='plan-exec-graph',
        run_error_event_id='plan-exec-graph-error',
        done_event_id='plan-exec-done',
        empty_final_user_hint='Plan execution finished without a final summary.',
        failed_start_message='Plan executor failed: {exc}',
        failed_run_message='Plan executor error: {exc}',
        thread_kind='plan_exec',
        done_detail='Plan execution complete',
    )

    hitl_bypass_token = deferred_tool_hitl_bypass.set(True)
    try:
        async for line in _stream_langgraph_tool_agent(
            session,
            tool_apply_mode,
            exec_prompt,
            cfg=exec_cfg,
            outcome=exec_outcome,
            outer_graph_builder=_plan_execute_outer_graph_builder,
        ):
            if session.abort_event.is_set():
                exec_outcome.mark_aborted()
                break
            yield line
    finally:
        deferred_tool_hitl_bypass.reset(hitl_bypass_token)

    exec_result = exec_outcome.best_available_text()
    exec_ok = exec_outcome.state == AgentLoopOutcome.COMPLETED

    yield sse_line(
        status_event(
            exec_status_id,
            EXECUTE_BUILD_PLAN_LABEL,
            detail=truncate_text(exec_result or record.title, 200),
            state='complete' if exec_ok else 'error',
            source='tool',
            stream_tag=PLANNER_STREAM_TAG,
        )
    )

    if exec_outcome.state == AgentLoopOutcome.ABORTED or session.abort_event.is_set():
        outcome.mark_aborted(partial_text=exec_result)
        return

    if not exec_ok:
        err_detail = exec_outcome.error_detail or 'plan execution failed'
        outcome.mark_failed_runtime(
            err_detail,
            final_text=exec_result or exec_outcome.final_text or cfg.failed_run_message.format(exc=err_detail),
            partial_text=exec_result,
        )
        yield sse_line(
            planner_progress_event(
                _planner_progress_payload(phase='error', steps=step_rows),
            )
        )
        return

    complete_build_plan(session, record.id)
    final_text = exec_result.strip() or 'Plan completed.'
    outcome.mark_completed(final_text=final_text)
    yield sse_line(
        planner_progress_event(
            planner_progress_payload_from_parsed(
                [{'id': row['id'], 'text': row['text'], 'complete': row['state'] == 'complete'} for row in step_rows],
                phase='complete',
            )
        )
    )
    yield sse_line(
        status_event(
            cfg.done_event_id,
            cfg.status_label,
            detail=cfg.done_detail,
            state='complete',
            source='agent',
        )
    )


__all__ = [
    'BuildPlanModel',
    'EXECUTE_BUILD_PLAN_LABEL',
    'PLAN_AUTHORING_GUIDELINES',
    'PLAN_EXECUTE_APPLY_MODE',
    'RECORD_PLAN_LABEL',
    'build_build_plan_executor_prompt',
    'build_planner_context_block',
    'emit_planner_progress_from_md',
    'stream_plan_execute_langgraph',
]
