"""Plan-and-execute orchestrator (LangGraph tutorial control flow, nemo streaming/HITL).

Read-only discovery (:mod:`nemo_backend.plan_discovery`) runs before planning; the planner
proposes a structured build plan written to ``.nemo/build-plans/``; user approves via
:mod:`nemo_backend.plan_confirm`; a single ReAct executor run implements the plan using
:mod:`nemo_backend.tools.build_plan_tools` to mark milestones.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_core.prompts import ChatPromptTemplate

from nemo_backend.agent_langgraph import AgentGraphConfig, _stream_langgraph_tool_agent, build_nemo_single_outer_graph
from nemo_backend.agent_loop import AgentLoopOutcome, LangGraphWorkerOutcome
from nemo_backend.agent_pause import await_diff_review_note
from nemo_backend.agent_streaming import (
    build_plan_open_event,
    planner_progress_event,
    plan_confirm_event,
    sse_line,
    status_event,
)
from nemo_backend.build_plan_store import (
    BuildPlanModel,
    complete_build_plan,
    create_build_plan,
    planner_progress_payload_from_parsed,
)
from nemo_backend.deferred_tool_hitl import deferred_tool_hitl_bypass
from nemo_backend.domain import SessionState
from nemo_backend.llm import build_llm
from nemo_backend.llm_interaction_logging import log_llm_failure
from nemo_backend.messages import build_system_prompt, stringify_content
from nemo_backend.plan_confirm import plan_confirm_sse_payload, stage_plan_confirm_request
from nemo_backend.plan_discovery import (
    PLAN_DISCOVERY_EXECUTE_LABEL,
    build_freeform_discovery_prompt,
)
from nemo_backend.stream_tags import PLANNER_STREAM_TAG
from nemo_backend.tool_registry import format_tools_catalog, plan_execute_tools_and_map
from nemo_backend.tools.workspace import truncate_text

logger = logging.getLogger('nemo.plan_execute')

RECORD_PLAN_LABEL = 'record_plan'
EXECUTE_BUILD_PLAN_LABEL = 'execute_build_plan'

# Plan mode always binds the full outer-agent tool surface (staging, transfer, deps, tests, …)
# regardless of the toolbar Editor toggle for this HTTP request.
PLAN_EXECUTE_APPLY_MODE = True


PLAN_DRAFTING_OVERRIDE = (
    'Plan drafting override (for initial plan only — supersedes general inspect-first guidance above):\n'
    '- Read-only discovery already completed in a prior phase; do not plan exploration steps.\n'
    '- Plan only work the executor should mutate or deliver.'
)


def build_planner_context_block(
    session: SessionState,
    apply_mode: bool,
    *,
    for_initial_plan: bool = False,
) -> str:
    """System prompt + tool catalog shared by the planner (matches executor bindings)."""
    system_prompt = build_system_prompt(session, apply_mode)
    tools, _ = plan_execute_tools_and_map(apply_mode, session=session)
    catalog = format_tools_catalog(tools)
    override = f'{PLAN_DRAFTING_OVERRIDE}\n\n' if for_initial_plan else ''
    return (
        f'{system_prompt}\n\n'
        f'{override}'
        'Available tools (same bindings the executor will use):\n'
        f'{catalog}'
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


def _planner_chain(planner_context: str, *, discovery_summary: str = ''):
    discovery_block = _build_discovery_preamble(discovery_summary)
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                f'{_escape_prompt_template_braces(planner_context)}'
                f'{_escape_prompt_template_braces(discovery_block)}\n\n'
                'You are in plan mode. For the given objective, produce a build plan with these sections:\n'
                '- title: short document title\n'
                '- task: user goal in plain language\n'
                '- current_implementation: relevant existing behavior from discovery\n'
                '- files_to_change: list of "path — rationale" lines\n'
                '- action_steps: ordered milestones the executor will implement (mutating/delivering work only)\n\n'
                'Rules:\n'
                '- Each action step must describe mutating or delivering work (edit, create, delete, '
                'stage/transfer, configure, run tests or smoke checks, install dependencies, etc.).\n'
                '- Do not add steps whose primary purpose is read-only discovery.\n'
                '- Use coarse-grained milestones (roughly one major outcome per step).\n'
                '- Do not add superfluous steps. The final step should complete the objective.',
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

    from nemo_backend.build_plan_store import parse_action_steps, read_build_plan_text

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
    return build_nemo_single_outer_graph(
        llm,
        session,
        apply_mode,
        extra_middleware=extra_middleware,
        tools_provider=plan_execute_tools_and_map,
    )


async def _invoke_planner(
    user_input: str,
    *,
    session: SessionState,
    apply_mode: bool,
    discovery_summary: str = '',
) -> BuildPlanModel:
    chain = _planner_chain(
        build_planner_context_block(session, apply_mode, for_initial_plan=True),
        discovery_summary=discovery_summary,
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
        plan_model = await _invoke_planner(
            user_input,
            session=session,
            apply_mode=tool_apply_mode,
            discovery_summary=discovery_summary,
        )
    except Exception as exc:
        logger.exception('Plan mode planner failed')
        log_llm_failure(exc, context='plan:planner', agent_role=None)
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

    action_steps = [s.strip() for s in plan_model.action_steps if s.strip()]
    if not action_steps:
        outcome.mark_completed(
            final_text='The planner returned an empty plan. Try rephrasing your request.',
        )
        yield sse_line(
            status_event(
                'plan-empty',
                'Planning',
                detail='No action steps generated.',
                state='error',
                stream_tag=PLANNER_STREAM_TAG,
            )
        )
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
        record = create_build_plan(
            session.workspace_path,
            session_id,
            plan_model,
            session=session,
        )
    except Exception as exc:
        logger.exception('Build plan store write failed')
        outcome.mark_failed_runtime(str(exc), final_text=cfg.failed_run_message.format(exc=exc))
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

    step_rows = _steps_from_texts(action_steps)
    yield sse_line(
        planner_progress_event(
            _planner_progress_payload(phase='planning', steps=step_rows, plan_ready=True),
        )
    )
    yield sse_line(
        build_plan_open_event(
            {
                'planId': record.id,
                'relativePath': record.relative_path,
                'title': record.title,
                'previewMode': True,
            }
        )
    )

    pending = stage_plan_confirm_request(
        session,
        steps=action_steps,
        build_plan_id=record.id,
        build_plan_path=record.relative_path,
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
    'PLAN_EXECUTE_APPLY_MODE',
    'RECORD_PLAN_LABEL',
    'build_build_plan_executor_prompt',
    'build_planner_context_block',
    'emit_planner_progress_from_md',
    'stream_plan_execute_langgraph',
]
