"""Plan-and-execute orchestrator (LangGraph tutorial control flow, nemo streaming/HITL).

Read-only discovery (:mod:`nemo_backend.plan_discovery`) runs before planning; the planner
proposes steps; user approves via :mod:`nemo_backend.plan_confirm`; each step runs
through the existing ReAct executor (:func:`~nemo_backend.agent_langgraph._stream_langgraph_tool_agent`);
a lightweight structured LLM verifier (:mod:`nemo_backend.plan_step_verify`) gates step completion;
replanner decides whether to finish or extend the remaining plan.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

from nemo_backend.agent_langgraph import AgentGraphConfig, _stream_langgraph_tool_agent
from nemo_backend.agent_loop import AgentLoopOutcome, LangGraphWorkerOutcome
from nemo_backend.agent_pause import await_diff_review_note
from nemo_backend.agent_streaming import (
    planner_progress_event,
    plan_confirm_event,
    sse_line,
    status_event,
)
from nemo_backend.checkpointing import delete_outer_thread
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
from nemo_backend.plan_step_verify import (
    PLAN_STEP_VERIFY_MAX_RETRIES,
    VERIFY_PLAN_STEP_LABEL,
    invoke_step_verifier,
)
from nemo_backend.stream_tags import PLANNER_STREAM_TAG
from nemo_backend.tool_registry import format_tools_catalog, worker_tools_and_map
from nemo_backend.workspace_tools import truncate_text

logger = logging.getLogger('nemo.plan_execute')

RECORD_PLAN_LABEL = 'record_plan'
EXECUTE_PLAN_STEP_LABEL = 'execute_plan_step'

# Plan mode always binds the full outer-agent tool surface (staging, transfer, deps, tests, …)
# regardless of the toolbar Editor toggle for this HTTP request.
PLAN_EXECUTE_APPLY_MODE = True


class PlanModel(BaseModel):
    """Structured planner output."""

    steps: list[str] = Field(
        description=(
            'Ordered implementation steps to accomplish the objective; each step must mutate or '
            'deliver work (edit, create, delete, stage/transfer, configure, test, install deps, etc.). '
            'Do not include read-only discovery steps (search, explore, inspect, read files).'
        ),
    )


class ReplanAct(BaseModel):
    """Replanner: either respond to the user or emit a follow-up plan."""

    response: str = Field(default='', description='When set, this is the final answer.')
    steps: list[str] = Field(
        default_factory=list,
        description='When non-empty, remaining steps still needed (do not repeat completed steps).',
    )


PLAN_DRAFTING_OVERRIDE = (
    'Plan drafting override (for initial plan only — supersedes general inspect-first guidance above):\n'
    '- Read-only discovery already completed in a prior phase; do not plan exploration steps.\n'
    '- Plan only work the step executor should mutate or deliver.'
)


def build_planner_context_block(
    session: SessionState,
    apply_mode: bool,
    *,
    for_initial_plan: bool = False,
) -> str:
    """System prompt + tool catalog shared by planner and replanner (matches step executor bindings)."""
    system_prompt = build_system_prompt(session, apply_mode)
    tools, _ = worker_tools_and_map(apply_mode, session=session)
    catalog = format_tools_catalog(tools)
    override = f'{PLAN_DRAFTING_OVERRIDE}\n\n' if for_initial_plan else ''
    return (
        f'{system_prompt}\n\n'
        f'{override}'
        'Available tools (same bindings the step executor will use):\n'
        f'{catalog}'
    )


def _build_discovery_preamble(discovery_summary: str) -> str:
    summary = (discovery_summary or '').strip()
    if summary:
        findings = (
            'Discovery has already run. Findings (authoritative — ground plan steps in these facts):\n'
            f'{summary}'
        )
    else:
        findings = (
            'Discovery has already run in a prior phase and produced no additional findings beyond '
            'the workspace context above.'
        )
    return (
        f'\n\n{findings}\n\n'
        'Do not add plan steps whose only purpose is read-only discovery (search, explore, inspect, '
        'locate, read files, semantic lookup, or "understand the codebase"). '
        'Assume sufficient context exists to start implementation.'
    )


def _escape_prompt_template_braces(text: str) -> str:
    """Escape literal ``{``/``}`` so dynamic context (tool catalogs, summaries) is not parsed as
    ChatPromptTemplate input variables."""
    return text.replace('{', '{{').replace('}', '}}')


def _planner_chain(planner_context: str, *, discovery_summary: str = ''):
    discovery_block = _build_discovery_preamble(discovery_summary)
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                f'{_escape_prompt_template_braces(planner_context)}'
                f'{_escape_prompt_template_braces(discovery_block)}\n\n'
                'You are in plan mode. For the given objective, come up with a simple implementation '
                'step-by-step plan.\n\n'
                'Rules:\n'
                '- Each step must describe mutating or delivering work (edit, create, delete, '
                'stage/transfer, configure, run tests or smoke checks, install dependencies, etc.).\n'
                '- Do not add steps whose primary purpose is read-only discovery.\n'
                '- Each step should be individually actionable with the available tools listed above.\n'
                '- Use coarse-grained steps (roughly one major action per step).\n'
                '- Do not list substeps, nested bullets, or micro-tasks inside a step.\n'
                '- Do not add superfluous steps. The final step should complete the objective.',
            ),
            ('placeholder', '{messages}'),
        ]
    )
    return prompt | build_llm().with_structured_output(PlanModel)


def _replanner_chain(planner_context: str):
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                f'{_escape_prompt_template_braces(planner_context)}\n\n'
                'You are in plan mode (replanner). After one plan step completes, decide whether the '
                'objective is satisfied or additional work is needed.\n\n'
                'Rules:\n'
                '- Use one level of steps only (no substeps or nested task lists).\n'
                '- Do NOT rewrite, expand, or replace steps still listed under remaining approved steps.\n'
                '- Do NOT restate completed work or pending approved steps in `steps`.\n'
                '- If the objective is fully satisfied and no further execution is needed, set `response` '
                'to the final answer and leave `steps` empty.\n'
                '- If remaining approved steps still need to run, leave `response` and `steps` empty '
                '(the orchestrator continues automatically).\n'
                '- NEVER set `response` to say that remaining steps are queued, pending, or will run later — '
                'that does not finish the plan.\n'
                '- Only populate `steps` with genuinely NEW work discovered during execution that is '
                'not already covered by remaining approved steps.',
            ),
            (
                'human',
                """Your objective was:
{input}

Your original plan was:
{plan}

Remaining approved steps (not yet started):
{remaining_steps}

You have currently done the following steps:
{past_steps}

If the user's objective is fully satisfied with nothing left to execute, set `response` to the final answer and leave `steps` empty.
If remaining approved steps still need to run, leave `response` and `steps` empty.
Otherwise, set `steps` to only the additional NEW steps still required.""",
            ),
        ]
    )
    return prompt | build_llm().with_structured_output(ReplanAct)


def _step_id(index: int) -> str:
    return f'step-{index + 1}'


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
    added_flags: list[bool] | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, text in enumerate(texts):
        state = states[i] if states and i < len(states) else 'pending'
        row: dict[str, Any] = {'id': _step_id(i), 'text': text.strip(), 'state': state}
        if added_flags and i < len(added_flags) and added_flags[i]:
            row['addedDuringExecution'] = True
        out.append(row)
    return out


def build_step_task_prompt(
    plan_steps: list[str],
    step_index: int,
    *,
    verifier_feedback: str | None = None,
) -> str:
    """Format the executor user message for one plan step."""

    plan_str = '\n'.join(f'{i + 1}. {step}' for i, step in enumerate(plan_steps))
    task = plan_steps[step_index]
    body = (
        f'For the following plan:\n{plan_str}\n\n'
        f'You are tasked with executing step {step_index + 1}: {task}\n\n'
        'Execute **this step now** using tools. Do not defer work to later plan steps, do not say '
        'that other steps are "queued" or "pending", and do not end your turn until this step\'s '
        'concrete work is finished (including staging, transfer, or direct writes when edits are required). '
        'When done, summarize what you accomplished.'
    )
    fb = (verifier_feedback or '').strip()
    if fb:
        body += (
            f'\n\n**Verifier feedback (previous attempt did not satisfy this step):**\n{fb}\n\n'
            'Address the feedback and complete this step before ending your turn.'
        )
    return body


def _format_past_steps(past_steps: list[tuple[str, str]]) -> str:
    if not past_steps:
        return '(none)'
    lines: list[str] = []
    for i, (task, result) in enumerate(past_steps, start=1):
        excerpt = truncate_text(stringify_content(result).strip(), 800)
        lines.append(f'{i}. {task}\n   Result: {excerpt}')
    return '\n'.join(lines)


async def _invoke_planner(
    user_input: str,
    *,
    session: SessionState,
    apply_mode: bool,
    discovery_summary: str = '',
) -> PlanModel:
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
    """Run a single free-form read-only discovery pass (no a-priori action list).

    The model explores the workspace with read-only tools, deciding its own next
    action as it goes, then returns a findings summary that feeds the implementation
    planner. Yields SSE lines; appends the discovery summary to ``summary_out``.
    """

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


def _format_remaining_steps(remaining_steps: list[str]) -> str:
    if not remaining_steps:
        return '(none — all originally approved steps have been attempted)'
    return '\n'.join(f'{i + 1}. {s}' for i, s in enumerate(remaining_steps))


def _append_new_plan_steps(
    new_steps: list[str],
    *,
    all_step_texts: list[str],
    step_states: list[str],
    step_added_flags: list[bool],
    past_steps: list[tuple[str, str]],
) -> list[str]:
    """Register novel replanner steps and return the queue slice to execute next."""
    completed_tasks = {task for task, _ in past_steps}
    queued: list[str] = []
    for step in new_steps:
        text = step.strip()
        if not text or text in completed_tasks:
            continue
        if text not in all_step_texts:
            all_step_texts.append(text)
            step_states.append('pending')
            step_added_flags.append(True)
        idx = all_step_texts.index(text)
        if step_states[idx] == 'complete':
            continue
        if text not in queued:
            queued.append(text)
    return queued


async def _invoke_replanner(
    *,
    user_input: str,
    plan_steps: list[str],
    remaining_steps: list[str],
    past_steps: list[tuple[str, str]],
    session: SessionState,
    apply_mode: bool,
) -> ReplanAct:
    chain = _replanner_chain(build_planner_context_block(session, apply_mode))
    plan_str = '\n'.join(f'{i + 1}. {s}' for i, s in enumerate(plan_steps)) or '(empty)'
    return await chain.ainvoke(
        {
            'input': user_input,
            'plan': plan_str,
            'remaining_steps': _format_remaining_steps(remaining_steps),
            'past_steps': _format_past_steps(past_steps),
        }
    )


async def stream_plan_execute_langgraph(
    session: SessionState,
    user_message: str | list[dict[str, Any]],
    apply_mode: bool,
    *,
    session_id: str,
    outcome: LangGraphWorkerOutcome,
) -> AsyncIterator[str]:
    """Run plan-and-execute with plan approval HITL and per-step ReAct execution.

    ``apply_mode`` on the HTTP request is ignored for tool binding: plan steps always run with
    the full editor-capable outer agent (:data:`PLAN_EXECUTE_APPLY_MODE`).
    """

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

    plan_steps = [s.strip() for s in plan_model.steps if s.strip()]
    if not plan_steps:
        outcome.mark_completed(
            final_text='The planner returned an empty plan. Try rephrasing your request.',
        )
        yield sse_line(
            status_event(
                'plan-empty',
                'Planning',
                detail='No steps generated.',
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
            detail=f'Plan with {len(plan_steps)} step(s) ready for review.',
            state='complete',
            source='tool',
            stream_tag=PLANNER_STREAM_TAG,
        )
    )
    step_rows = _steps_from_texts(plan_steps)
    yield sse_line(
        planner_progress_event(
            _planner_progress_payload(phase='planning', steps=step_rows, plan_ready=True),
        )
    )

    pending = stage_plan_confirm_request(session, steps=plan_steps)
    yield sse_line(plan_confirm_event(plan_confirm_sse_payload(pending)))
    await await_diff_review_note(session_id)

    if session.plan_execute_aborted or session.abort_event.is_set():
        outcome.mark_aborted()
        return

    past_steps: list[tuple[str, str]] = []
    remaining = list(plan_steps)
    all_step_texts = list(plan_steps)
    step_states = ['pending'] * len(all_step_texts)
    step_added_flags = [False] * len(all_step_texts)
    final_text = ''

    def _progress_steps(**kwargs: Any) -> list[dict[str, Any]]:
        return _steps_from_texts(all_step_texts, states=step_states, added_flags=step_added_flags)

    yield sse_line(
        planner_progress_event(
            _planner_progress_payload(phase='executing', steps=_progress_steps()),
        )
    )

    while remaining and not session.abort_event.is_set():
        task = remaining[0]
        global_idx = all_step_texts.index(task) if task in all_step_texts else 0
        if global_idx < len(step_states):
            step_states[global_idx] = 'running'
        active_id = _step_id(global_idx)
        yield sse_line(
            planner_progress_event(
                _planner_progress_payload(
                    phase='executing',
                    steps=_progress_steps(),
                    active_step_id=active_id,
                )
            )
        )

        exec_status_id = f'plan-exec-{uuid.uuid4().hex[:10]}'
        yield sse_line(
            status_event(
                exec_status_id,
                EXECUTE_PLAN_STEP_LABEL,
                detail=truncate_text(task, 200),
                state='running',
                source='tool',
                stream_tag=PLANNER_STREAM_TAG,
            )
        )

        verifier_feedback: str | None = None
        step_result = ''
        step_ok = False
        step_outcome = LangGraphWorkerOutcome()
        verify_attempt = 0

        while verify_attempt <= PLAN_STEP_VERIFY_MAX_RETRIES and not session.abort_event.is_set():
            step_prompt = build_step_task_prompt(all_step_texts, global_idx, verifier_feedback=verifier_feedback)
            step_outcome = LangGraphWorkerOutcome()
            ck_key = f'{session_id}:plan_exec:{global_idx}:r{verify_attempt}'
            exec_cfg = AgentGraphConfig(
                session_id=session_id,
                checkpoint_session_key=ck_key,
                graph_name='plan_exec',
                agent_role=None,
                status_label='Agent',
                llm_event_prefix='step',
                config_error_event_id='plan-exec-graph',
                run_error_event_id='plan-exec-graph-error',
                done_event_id='plan-exec-done',
                empty_final_user_hint='Step finished without a final summary.',
                failed_start_message='Step executor failed: {exc}',
                failed_run_message='Step executor error: {exc}',
                thread_kind='plan_exec',
                done_detail='Step complete',
            )

            # Plan approval already covers execute-tool consent; skip per-command accept cards here.
            hitl_bypass_token = deferred_tool_hitl_bypass.set(True)
            try:
                async for line in _stream_langgraph_tool_agent(
                    session,
                    tool_apply_mode,
                    step_prompt,
                    cfg=exec_cfg,
                    outcome=step_outcome,
                ):
                    if session.abort_event.is_set():
                        step_outcome.mark_aborted()
                        break
                    yield line
            finally:
                deferred_tool_hitl_bypass.reset(hitl_bypass_token)

            step_result = step_outcome.best_available_text()
            step_ok = step_outcome.state == AgentLoopOutcome.COMPLETED
            if not step_ok:
                break

            verify_status_id = f'plan-verify-{uuid.uuid4().hex[:10]}'
            yield sse_line(
                status_event(
                    verify_status_id,
                    VERIFY_PLAN_STEP_LABEL,
                    detail=truncate_text(task, 200),
                    state='running',
                    source='tool',
                    stream_tag=PLANNER_STREAM_TAG,
                )
            )
            try:
                verify_result = await invoke_step_verifier(
                    objective=user_input,
                    plan_steps=all_step_texts,
                    step_index=global_idx,
                    executor_summary=step_result,
                )
            except Exception as exc:
                logger.exception('Plan step verifier failed')
                log_llm_failure(exc, context='plan:step_verify', agent_role=None)
                yield sse_line(
                    status_event(
                        verify_status_id,
                        VERIFY_PLAN_STEP_LABEL,
                        detail='Verifier unavailable; accepting executor summary.',
                        state='complete',
                        source='tool',
                        stream_tag=PLANNER_STREAM_TAG,
                    )
                )
                break

            verify_detail = truncate_text(
                verify_result.evidence or verify_result.feedback or task,
                200,
            )
            if verify_result.approved:
                yield sse_line(
                    status_event(
                        verify_status_id,
                        VERIFY_PLAN_STEP_LABEL,
                        detail=verify_detail,
                        state='complete',
                        source='tool',
                        stream_tag=PLANNER_STREAM_TAG,
                    )
                )
                break

            yield sse_line(
                status_event(
                    verify_status_id,
                    VERIFY_PLAN_STEP_LABEL,
                    detail=verify_detail,
                    state='error',
                    source='tool',
                    stream_tag=PLANNER_STREAM_TAG,
                )
            )
            verify_attempt += 1
            if verify_attempt > PLAN_STEP_VERIFY_MAX_RETRIES:
                step_ok = False
                step_result = (
                    verify_result.feedback.strip()
                    or verify_result.evidence.strip()
                    or 'Step verification failed after retries.'
                )
                break
            verifier_feedback = verify_result.feedback.strip() or verify_result.evidence.strip()
            await delete_outer_thread(ck_key, 'plan_exec', apply_mode=tool_apply_mode)

        if global_idx < len(step_states):
            step_states[global_idx] = 'complete' if step_ok else 'error'

        yield sse_line(
            status_event(
                exec_status_id,
                EXECUTE_PLAN_STEP_LABEL,
                detail=truncate_text(step_result or task, 200),
                state='complete' if step_ok else 'error',
                source='tool',
                stream_tag=PLANNER_STREAM_TAG,
            )
        )
        yield sse_line(
            planner_progress_event(
                _planner_progress_payload(
                    phase='executing',
                    steps=_progress_steps(),
                )
            )
        )

        if not step_ok:
            if step_outcome.state == AgentLoopOutcome.ABORTED:
                outcome.mark_aborted(partial_text=step_result)
                return
            await delete_outer_thread(ck_key, 'plan_exec', apply_mode=tool_apply_mode)
            verify_failed = step_outcome.state == AgentLoopOutcome.COMPLETED
            err_detail = (
                'step verification failed'
                if verify_failed
                else (step_outcome.error_detail or 'step failed')
            )
            outcome.mark_failed_runtime(
                err_detail,
                final_text=step_result or step_outcome.final_text or cfg.failed_run_message.format(exc=err_detail),
                partial_text=step_result,
            )
            yield sse_line(
                planner_progress_event(
                    _planner_progress_payload(
                        phase='error',
                        steps=_progress_steps(),
                    )
                )
            )
            return

        past_steps.append((task, step_result))
        remaining = remaining[1:]

        # While approved steps remain, keep executing — do not consult the replanner (it may
        # incorrectly "finish" by narrating that later steps are queued).
        if remaining:
            continue

        try:
            replan = await _invoke_replanner(
                user_input=user_input,
                plan_steps=all_step_texts,
                remaining_steps=remaining,
                past_steps=past_steps,
                session=session,
                apply_mode=tool_apply_mode,
            )
        except Exception as exc:
            logger.exception('Plan mode replanner failed')
            log_llm_failure(exc, context='plan:replanner', agent_role=None)
            outcome.mark_failed_runtime(str(exc), final_text=cfg.failed_run_message.format(exc=exc))
            return

        if replan.response.strip():
            final_text = replan.response.strip()
            break

        new_steps = [s.strip() for s in replan.steps if s.strip()]
        if new_steps:
            # Approved queue exhausted — only then accept net-new follow-up steps.
            remaining = _append_new_plan_steps(
                new_steps,
                all_step_texts=all_step_texts,
                step_states=step_states,
                step_added_flags=step_added_flags,
                past_steps=past_steps,
            )
            if remaining:
                yield sse_line(
                    planner_progress_event(
                        _planner_progress_payload(
                            phase='executing',
                            steps=_progress_steps(),
                        )
                    )
                )
        else:
            final_text = step_result.strip() or 'Plan completed.'
            break

    if session.abort_event.is_set():
        outcome.mark_aborted()
        return

    if not final_text.strip():
        final_text = past_steps[-1][1].strip() if past_steps else cfg.empty_final_user_hint

    outcome.mark_completed(final_text=final_text)
    yield sse_line(
        planner_progress_event(
            _planner_progress_payload(
                phase='complete',
                steps=_progress_steps(),
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
    'EXECUTE_PLAN_STEP_LABEL',
    'PLAN_EXECUTE_APPLY_MODE',
    'RECORD_PLAN_LABEL',
    'build_planner_context_block',
    'build_step_task_prompt',
    'stream_plan_execute_langgraph',
]
