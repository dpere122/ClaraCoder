"""Deterministic coding-planner orchestrator: bounded discovery, structured plan, sequential execution."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

from nemo_backend.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from nemo_backend.copy_review_middleware import CopyReviewAfterToolMiddleware
from nemo_backend.delete_review_middleware import DeleteReviewAfterToolMiddleware
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.tool_harness_feedback_middleware import prepend_harness_feedback_middleware
from nemo_backend.agents.coding_planner.plan_llm import run_plan_probe_llm, run_structured_build_plan_llm
from nemo_backend.agents.coding_planner.planner_core import (
    FINAL_PROJECT_REVIEW_FAILURE_PREFIX,
    PLANNER_NO_TRANSFER_STEP_RETRY_SUFFIX,
    StepProxyQueue,
    auto_remediation_step_text_from_final_review,
    build_final_project_review_instruction,
    compose_fast_path_step_instruction,
    enqueue_planner_event,
    enqueue_planner_progress,
    had_new_workspace_transfer_since,
    needs_python_env_bootstrap,
    next_plan_step_index,
    planner_progress_snapshot,
    planner_terminal_phase_with_review,
    project_review_reentry_payload,
    parse_plan_steps,
    snapshot_workspace_applied_flags,
    sorted_pending_staging_paths,
    suppress_parent_graph_model_token_sse,
    task_complexity_profile,
    truncate_step_result,
    validate_initial_plan_steps,
    validate_probe_plan_steps,
    scope_text_mentions_programming_paths,
)
from nemo_backend.agents.coding_planner.prompts import build_discovery_system_prompt
from nemo_backend.agents.orchestration.nested_pipeline import (
    NESTED_WORKER_STREAM_END,
    enqueue_plan_and_modify_outer_brief,
    run_final_project_review_stream,
    run_planning_nested_stream,
)
from nemo_backend import config as nemo_config
from nemo_backend.domain import SessionState
from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from nemo_backend.llm import build_llm
from nemo_backend.lsp.tools import (
    lsp_find_definition,
    lsp_find_references,
    lsp_get_diagnostics,
    lsp_get_document_symbols,
    lsp_hover,
)
from nemo_backend.messages import final_assistant_text
from nemo_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from nemo_backend.pseudo_tool_xml_middleware import PseudoToolXmlMiddleware
from nemo_backend.python_env import ensure_session_python_workspace_env
from nemo_backend.state import get_active_connection
from nemo_backend.workspace_index.semantic_tool import retrieve_workspace_semantic
from nemo_backend.workspace_tools import list_workspace_directory, read_workspace_file, search_workspace

logger = logging.getLogger('nemo.agent.langgraph.coding_planner')


def _orch_context_message(
    *,
    phase: str,
    task_excerpt: str,
    step_index: int | None,
    total_steps: int | None,
    next_action: str,
) -> str:
    si = f'{step_index}/{total_steps}' if step_index is not None and total_steps else 'n/a'
    return (
        f'[Orchestrator state]\n'
        f'- phase: {phase}\n'
        f'- step: {si}\n'
        f'- next: {next_action}\n'
        f'- task (excerpt): {(task_excerpt or "")[:800]}\n'
    )


async def _bootstrap_workspace_python(session: SessionState, nested_q: Any) -> str | None:
    if not needs_python_env_bootstrap(session):
        return None
    bootstrap_result = await ensure_session_python_workspace_env(
        session,
        allow_workspace_root_fallback=False,
        bootstrap_dependencies=True,
    )
    if bootstrap_result is None:
        await nested_q.put(NESTED_WORKER_STREAM_END)
        return (
            'Tool error: the coding planner requires a workspace Python environment for this project, '
            'but no Python workspace could be resolved.'
        )
    if not bootstrap_result.ok:
        await nested_q.put(NESTED_WORKER_STREAM_END)
        return (
            'Tool error: the coding planner could not initialize the workspace Python environment before '
            'planning began.\n\n'
            f'{bootstrap_result.summary}'
        )
    return None


async def run_discovery_subagent(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
    *,
    include_lsp_discovery: bool,
    planner_tag: str = 'planner',
) -> str:
    try:
        llm = build_llm()
    except Exception:
        logger.exception('discovery subagent: build_llm failed')
        return ''

    lsp_block: list[Any] = [
        lsp_get_diagnostics,
        lsp_hover,
        lsp_find_definition,
        lsp_find_references,
        lsp_get_document_symbols,
    ]
    tools: list[Any] = [
        list_workspace_directory,
        retrieve_workspace_semantic,
        search_workspace,
        read_workspace_file,
        *(lsp_block if include_lsp_discovery else []),
    ]
    system_prompt = build_discovery_system_prompt(session, include_lsp_discovery=include_lsp_discovery)
    graph = create_agent(
        llm,
        tools,
        system_prompt=system_prompt,
        name='nemo_coding_planner_discovery',
        middleware=prepend_harness_feedback_middleware(
            [
                ConnectionParallelToolCallsMiddleware(),
                PseudoToolXmlMiddleware(),
                EmptyResponseNudgeMiddleware(),
                AcceptCommandReviewAfterToolMiddleware(),
                DiffReviewAfterToolMiddleware(),
                DeleteReviewAfterToolMiddleware(),
                CopyReviewAfterToolMiddleware(),
            ],
        ),
        checkpointer=checkpointer,
    )
    thread_id = f'{session_id}:coding_planner_discovery:{uuid.uuid4().hex[:10]}'
    config: RunnableConfig = {
        'configurable': {'thread_id': thread_id},
        'recursion_limit': nemo_config.NEMO_PLANNER_DISCOVERY_RECURSION_LIMIT,
    }
    ctx = _orch_context_message(
        phase='discovery',
        task_excerpt=task_summary,
        step_index=None,
        total_steps=None,
        next_action='Use read/search tools, then end with Discovery complete:',
    )
    inputs: dict[str, Any] = {
        'messages': [
            HumanMessage(content=ctx + '\n\nTask:\n' + (task_summary.strip() or '(empty)')),
        ],
    }
    last_final_text = ''
    del llm
    with suppress_parent_graph_model_token_sse(session):
        async for ev in graph.astream_events(inputs, config, version='v2'):
            if session.abort_event.is_set():
                break
            await enqueue_planner_event(nested_q, planner_tag, ev)
            et = ev.get('event')
            data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
            if et == 'on_chat_model_end':
                raw = data.get('output')
                msg = raw if isinstance(raw, AIMessage) else None
                if msg is not None and not (msg.tool_calls or []):
                    last_final_text = final_assistant_text(msg)
    return (last_final_text or '').strip() or 'Discovery complete: (no summary text returned).'


async def _emit(
    nested_q: Any,
    *,
    planner_steps: list[dict[str, str]],
    ui_phase: str,
    orchestrator_phase: str,
    plan_ready: bool,
    final_review_state: str,
    final_review_attempts: int,
    final_review_summary: str,
    session: SessionState,
    active_step_id: str = '',
    recommended_transfer_order: list[str] | None = None,
) -> None:
    try:
        final_review_max_attempts = max(0, int(get_active_connection().plan_retry_attempts_count))
    except Exception:
        final_review_max_attempts = 0
    await enqueue_planner_progress(
        nested_q,
        'planner',
        planner_progress_snapshot(
            planner_steps,
            ui_phase,
            active_step_id=active_step_id,
            plan_ready=plan_ready,
            final_review_state=final_review_state,
            final_review_attempts=final_review_attempts,
            final_review_max_attempts=final_review_max_attempts,
            final_review_summary=final_review_summary,
            project_review_reentry=project_review_reentry_payload(session.pending_project_review_reentry),
            orchestrator_phase=orchestrator_phase,
            recommended_transfer_order=recommended_transfer_order,
        ),
    )


async def run_coding_planner_deterministic_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
    *,
    include_lsp_discovery: bool,
) -> str:
    """Discovery subagent → structured build plan → sequential nested runs → final review (+ remediation)."""
    err = await _bootstrap_workspace_python(session, nested_q)
    if err:
        return err
    
    last_final_text = ''
    planner_steps: list[dict[str, str]] = []
    final_review_state = 'pending'
    final_review_attempts = 0
    final_review_summary = ''
    step_proxy_q = StepProxyQueue(nested_q)
    profile = task_complexity_profile(task_summary)
    
    try:
        build_llm()
    except Exception:
        logger.exception('deterministic planner: build_llm failed')
        await nested_q.put(NESTED_WORKER_STREAM_END)
        raise

    try:
        with suppress_parent_graph_model_token_sse(session):
            await _emit(
                nested_q,
                planner_steps=planner_steps,
                ui_phase='discovery',
                orchestrator_phase='discovery',
                plan_ready=False,
                final_review_state=final_review_state,
                final_review_attempts=final_review_attempts,
                final_review_summary=final_review_summary,
                session=session,
            )
    
            discovery_notes = await run_discovery_subagent(
                session,
                session_id,
                task_summary,
                nested_q,
                checkpointer,
                include_lsp_discovery=include_lsp_discovery,
            )
    
            await _emit(
                nested_q,
                planner_steps=planner_steps,
                ui_phase='planning',
                orchestrator_phase='build_plan',
                plan_ready=False,
                final_review_state=final_review_state,
                final_review_attempts=final_review_attempts,
                final_review_summary=final_review_summary,
                session=session,
            )
    
            raw_steps = await run_structured_build_plan_llm(
                task_summary,
                profile=profile,
                discovery_notes=discovery_notes,
            )
            validation_feedback: str | None = None
            planner_steps = []
            for attempt in range(2):
                if raw_steps is None:
                    return (
                        'The coding planner could not produce a structured build plan. Try rephrasing the task.'
                    )
                plan_blob = '\n'.join(f'{i + 1}. {t}' for i, t in enumerate(raw_steps))
                parsed = parse_plan_steps(plan_blob)
                verr = validate_initial_plan_steps(parsed, profile, discovery_completed=True)
                if verr is None:
                    planner_steps = parsed
                    break
                validation_feedback = verr
                logger.info('build plan validation failed (attempt %s): %s', attempt + 1, verr)
                raw_steps = await run_structured_build_plan_llm(
                    task_summary,
                    profile=profile,
                    discovery_notes=discovery_notes,
                    validation_feedback=validation_feedback,
                )
            else:
                return validation_feedback or 'Tool error: plan validation failed.'

            plan_lines = '\n'.join(
                f'{i + 1}. {str(step.get("text") or "").strip()}' for i, step in enumerate(planner_steps)
            )
            await enqueue_plan_and_modify_outer_brief(
                session_id,
                nested_q,
                kind='plan_recorded',
                summary=plan_lines,
            )
            await _emit(
                nested_q,
                planner_steps=planner_steps,
                ui_phase='planning',
                orchestrator_phase='execute_steps',
                plan_ready=True,
                final_review_state=final_review_state,
                final_review_attempts=final_review_attempts,
                final_review_summary=final_review_summary,
                session=session,
            )
    
            total = max(1, len(planner_steps))
    
            async def _run_all_pending_steps() -> tuple[str, bool]:
                """Returns (message, ok). ok False means stop outer loop with error text."""
                nonlocal last_final_text, final_review_state, final_review_summary
                for idx, step in enumerate(planner_steps):
                    if step.get('state') == 'complete':
                        continue
                    if session.abort_event.is_set():
                        return 'Aborted by user.', False
                    sid = str(step.get('id') or '')
                    step['state'] = 'running'
                    await _emit(
                        nested_q,
                        planner_steps=planner_steps,
                        ui_phase='executing',
                        orchestrator_phase='execute_steps',
                        plan_ready=True,
                        final_review_state=final_review_state,
                        final_review_attempts=final_review_attempts,
                        final_review_summary=final_review_summary,
                        session=session,
                        active_step_id=sid,
                    )
                    instruction = compose_fast_path_step_instruction(
                        task_summary,
                        str(step.get('text') or ''),
                        step_index=idx + 1,
                        total_steps=total,
                        discovery_notes=discovery_notes,
                    )
                    applied_before = snapshot_workspace_applied_flags(session)
                    try:
                        step_result = await run_planning_nested_stream(
                            session,
                            session_id,
                            instruction,
                            step_proxy_q,
                            checkpointer,
                        )
                    except Exception:
                        step['state'] = 'error'
                        await _emit(
                            nested_q,
                            planner_steps=planner_steps,
                            ui_phase='error',
                            orchestrator_phase='execute_steps',
                            plan_ready=True,
                            final_review_state=final_review_state,
                            final_review_attempts=final_review_attempts,
                            final_review_summary=final_review_summary,
                            session=session,
                            active_step_id=sid,
                        )
                        raise
                    truncated = truncate_step_result(step_result)
                    lowered = step_result.lower()
                    if lowered.startswith('aborted by user'):
                        step['state'] = 'error'
                        return truncated, False
                    if lowered.startswith('tool error:'):
                        step['state'] = 'error'
                        feedback = truncated
                        if not had_new_workspace_transfer_since(session, applied_before):
                            feedback = truncated + PLANNER_NO_TRANSFER_STEP_RETRY_SUFFIX
                        await _emit(
                            nested_q,
                            planner_steps=planner_steps,
                            ui_phase='error',
                            orchestrator_phase='execute_steps',
                            plan_ready=True,
                            final_review_state=final_review_state,
                            final_review_attempts=final_review_attempts,
                            final_review_summary=final_review_summary,
                            session=session,
                            active_step_id=sid,
                            recommended_transfer_order=sorted_pending_staging_paths(session)
                            if len(session.pending_edit_stagings) > 1
                            else None,
                        )
                        return feedback, False
                    step['state'] = 'complete'
                    final_review_state = 'pending'
                    final_review_summary = ''
                    await _emit(
                        nested_q,
                        planner_steps=planner_steps,
                        ui_phase='executing',
                        orchestrator_phase='execute_steps',
                        plan_ready=True,
                        final_review_state=final_review_state,
                        final_review_attempts=final_review_attempts,
                        final_review_summary=final_review_summary,
                        session=session,
                        recommended_transfer_order=sorted_pending_staging_paths(session)
                        if len(session.pending_edit_stagings) > 1
                        else None,
                    )
                return '', True
    
            while True:
                msg, ok = await _run_all_pending_steps()
                if not ok:
                    last_final_text = msg
                    break
    
                if session.abort_event.is_set():
                    last_final_text = 'Aborted by user.'
                    break
    
                base_instruction = build_final_project_review_instruction(task_summary, planner_steps)
                final_review_state = 'running'
                final_review_summary = ''
                await _emit(
                    nested_q,
                    planner_steps=planner_steps,
                    ui_phase='executing',
                    orchestrator_phase='final_review',
                    plan_ready=True,
                    final_review_state=final_review_state,
                    final_review_attempts=final_review_attempts,
                    final_review_summary=final_review_summary,
                    session=session,
                )
                review_result = await run_final_project_review_stream(
                    session,
                    session_id,
                    base_instruction,
                    step_proxy_q,
                    checkpointer,
                )
                final_review_summary = review_result
                if not review_result.lower().startswith(FINAL_PROJECT_REVIEW_FAILURE_PREFIX.lower()):
                    final_review_state = 'complete'
                    session.pending_project_review_reentry = None
                    last_final_text = review_result
                    await _emit(
                        nested_q,
                        planner_steps=planner_steps,
                        ui_phase='executing',
                        orchestrator_phase='final_review',
                        plan_ready=True,
                        final_review_state=final_review_state,
                        final_review_attempts=final_review_attempts,
                        final_review_summary=final_review_summary,
                        session=session,
                    )
                    break
    
                final_review_attempts = 1
                session.pending_project_review_reentry = None
                new_idx = next_plan_step_index(planner_steps)
                planner_steps.append(
                    {
                        'id': f'step-{new_idx}',
                        'text': auto_remediation_step_text_from_final_review(review_result),
                        'state': 'pending',
                    }
                )
                final_review_state = 'pending'
                final_review_summary = 'Final project review failed; a remediation step was appended to the checklist.'
                plan_lines_br = '\n'.join(
                    f'{i + 1}. {str(step.get("text") or "").strip()}' for i, step in enumerate(planner_steps)
                )
                await enqueue_plan_and_modify_outer_brief(
                    session_id,
                    nested_q,
                    kind='plan_auto_remediation',
                    summary=plan_lines_br,
                )
                await _emit(
                    nested_q,
                    planner_steps=planner_steps,
                    ui_phase='planning',
                    orchestrator_phase='execute_steps',
                    plan_ready=True,
                    final_review_state=final_review_state,
                    final_review_attempts=final_review_attempts,
                    final_review_summary=final_review_summary,
                    session=session,
                )
    
    finally:
        try:
            final_review_max_attempts = max(0, int(get_active_connection().plan_retry_attempts_count))
        except Exception:
            final_review_max_attempts = 0
        await enqueue_planner_progress(
            nested_q,
            'planner',
            planner_progress_snapshot(
                planner_steps,
                planner_terminal_phase_with_review(planner_steps, final_review_state=final_review_state),
                plan_ready=bool(planner_steps),
                final_review_state=final_review_state,
                final_review_attempts=final_review_attempts,
                final_review_max_attempts=final_review_max_attempts,
                final_review_summary=final_review_summary,
                project_review_reentry=project_review_reentry_payload(session.pending_project_review_reentry),
                orchestrator_phase='done',
            ),
        )
        await nested_q.put(NESTED_WORKER_STREAM_END)

    if not last_final_text.strip():
        last_final_text = (
            'The coding planner finished without a final text response. Try rephrasing the task.'
        )
    return last_final_text


async def run_coding_planner_fast_path_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    planner_steps: list[dict[str, str]],
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Run probed 1–3 steps via ``run_planning_nested_stream`` each, then final project review (no full orchestrator)."""
    logger.info(
        'Coding planner fast path — steps=%d task_summary_length=%d',
        len(planner_steps),
        len(task_summary),
    )
    last_final_text = ''
    session.pending_project_review_reentry = None
    planner_tag = 'planner'
    final_review_state = 'pending'
    final_review_attempts = 0
    final_review_summary = ''

    if needs_python_env_bootstrap(session):
        bootstrap_result = await ensure_session_python_workspace_env(
            session,
            allow_workspace_root_fallback=False,
            bootstrap_dependencies=True,
        )
        if bootstrap_result is None:
            await nested_q.put(NESTED_WORKER_STREAM_END)
            return (
                'Tool error: the coding planner requires a workspace Python environment for this project, '
                'but no Python workspace could be resolved.'
            )
        if not bootstrap_result.ok:
            await nested_q.put(NESTED_WORKER_STREAM_END)
            return (
                'Tool error: the coding planner could not initialize the workspace Python environment before '
                'planning began.\n\n'
                f'{bootstrap_result.summary}'
            )

    step_proxy_q = StepProxyQueue(nested_q)
    discovery_notes = ''

    async def _emit_fp(phase: str, active_step_id: str = '') -> None:
        try:
            final_review_max_attempts = max(0, int(get_active_connection().plan_retry_attempts_count))
        except Exception:
            final_review_max_attempts = 0
        await enqueue_planner_progress(
            nested_q,
            planner_tag,
            planner_progress_snapshot(
                planner_steps,
                phase,
                active_step_id=active_step_id,
                plan_ready=True,
                final_review_state=final_review_state,
                final_review_attempts=final_review_attempts,
                final_review_max_attempts=final_review_max_attempts,
                final_review_summary=final_review_summary,
                project_review_reentry=project_review_reentry_payload(session.pending_project_review_reentry),
                orchestrator_phase='fast_path',
            ),
        )

    try:
        with suppress_parent_graph_model_token_sse(session):
            await _emit_fp(phase='discovery')
            plan_lines = '\n'.join(
                f'{i + 1}. {str(step.get("text") or "").strip()}' for i, step in enumerate(planner_steps)
            )
            await enqueue_plan_and_modify_outer_brief(
                session_id,
                nested_q,
                kind='plan_recorded',
                summary=plan_lines,
            )
            await _emit_fp(phase='planning')

            total = len(planner_steps) or 1
            for idx, step in enumerate(planner_steps):
                if session.abort_event.is_set():
                    last_final_text = 'Aborted by user.'
                    break
                sid = str(step.get('id') or '')
                step['state'] = 'running'
                await _emit_fp(phase='executing', active_step_id=sid)
                instruction = compose_fast_path_step_instruction(
                    task_summary,
                    str(step.get('text') or ''),
                    step_index=idx + 1,
                    total_steps=total,
                    discovery_notes=discovery_notes,
                )
                applied_before = snapshot_workspace_applied_flags(session)
                try:
                    step_result = await run_planning_nested_stream(
                        session,
                        session_id,
                        instruction,
                        step_proxy_q,
                        checkpointer,
                    )
                except Exception:
                    step['state'] = 'error'
                    await _emit_fp(phase='error', active_step_id=sid)
                    raise
                truncated = truncate_step_result(step_result)
                lowered = step_result.lower()
                if lowered.startswith('aborted by user'):
                    step['state'] = 'error'
                    await _emit_fp(phase='error', active_step_id=sid)
                    last_final_text = truncated
                    break
                if lowered.startswith('tool error:'):
                    step['state'] = 'error'
                    await _emit_fp(phase='error', active_step_id=sid)
                    last_final_text = truncated
                    if not had_new_workspace_transfer_since(session, applied_before):
                        last_final_text = truncated + PLANNER_NO_TRANSFER_STEP_RETRY_SUFFIX
                    break
                step['state'] = 'complete'
                await _emit_fp(phase='executing')

            if not last_final_text and session.abort_event.is_set():
                last_final_text = 'Aborted by user.'
            elif (
                not last_final_text
                and planner_steps
                and all(step.get('state') == 'complete' for step in planner_steps)
            ):
                final_review_state = 'running'
                final_review_summary = ''
                await _emit_fp(phase='executing')
                base_instruction = build_final_project_review_instruction(task_summary, planner_steps)
                review_result = await run_final_project_review_stream(
                    session,
                    session_id,
                    base_instruction,
                    step_proxy_q,
                    checkpointer,
                )
                final_review_summary = review_result
                if not review_result.lower().startswith(FINAL_PROJECT_REVIEW_FAILURE_PREFIX.lower()):
                    final_review_state = 'complete'
                    last_final_text = review_result
                else:
                    final_review_state = 'error'
                    final_review_attempts = 1
                    last_final_text = (
                        f'{review_result}\n\n'
                        'Fast path: final project review failed. Re-run `plan_and_modify` with a broader task '
                        'summary or the full orchestrator path will run automatic remediation on the next attempt.'
                    )
    except Exception:
        logger.exception('Coding planner fast path failed')
        raise
    finally:
        await enqueue_planner_progress(
            nested_q,
            planner_tag,
            planner_progress_snapshot(
                planner_steps,
                planner_terminal_phase_with_review(
                    planner_steps,
                    final_review_state=final_review_state,
                ),
                plan_ready=True,
                final_review_state=final_review_state,
                final_review_attempts=final_review_attempts,
                final_review_max_attempts=max(0, int(get_active_connection().plan_retry_attempts_count)),
                final_review_summary=final_review_summary,
                project_review_reentry=project_review_reentry_payload(session.pending_project_review_reentry),
                orchestrator_phase='fast_path',
            ),
        )
        await nested_q.put(NESTED_WORKER_STREAM_END)

    if not last_final_text.strip():
        last_final_text = (
            'The coding planner fast path finished without a final summary. Try rephrasing the task '
            'or use the full orchestrator.'
        )
    return last_final_text


async def run_coding_planner_orchestrated_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Probe + fast path for tiny plans; otherwise deterministic orchestrator."""
    complexity_profile = task_complexity_profile(task_summary)
    include_lsp = scope_text_mentions_programming_paths(task_summary)

    if not nemo_config.NEMO_PLAN_PROBE_ENABLED:
        return await run_coding_planner_deterministic_stream(
            session, session_id, task_summary, nested_q, checkpointer, include_lsp_discovery=include_lsp
        )

    if complexity_profile.max_steps >= nemo_config.NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS:
        logger.info(
            'plan probe skipped — max_steps=%d >= NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS=%d',
            complexity_profile.max_steps,
            nemo_config.NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS,
        )
        return await run_coding_planner_deterministic_stream(
            session, session_id, task_summary, nested_q, checkpointer, include_lsp_discovery=include_lsp
        )

    raw_steps = await run_plan_probe_llm(task_summary)
    if raw_steps is None:
        logger.info('plan probe unavailable — deterministic orchestrator')
        return await run_coding_planner_deterministic_stream(
            session, session_id, task_summary, nested_q, checkpointer, include_lsp_discovery=include_lsp
        )

    plan_blob = '\n'.join(f'{i + 1}. {t}' for i, t in enumerate(raw_steps))
    parsed = parse_plan_steps(plan_blob)
    probe_err = validate_probe_plan_steps(parsed)
    if probe_err:
        logger.info('plan probe invalid (%s) — deterministic orchestrator', probe_err)
        return await run_coding_planner_deterministic_stream(
            session, session_id, task_summary, nested_q, checkpointer, include_lsp_discovery=include_lsp
        )

    if len(parsed) >= 4:
        logger.info('plan probe returned %d steps — deterministic orchestrator', len(parsed))
        scope_lsp = scope_text_mentions_programming_paths(task_summary, *raw_steps)
        return await run_coding_planner_deterministic_stream(
            session, session_id, task_summary, nested_q, checkpointer, include_lsp_discovery=scope_lsp
        )

    if 1 <= len(parsed) <= nemo_config.NEMO_PLAN_FAST_PATH_MAX_STEPS:
        logger.info('plan probe fast path — %d step(s)', len(parsed))
        return await run_coding_planner_fast_path_stream(
            session,
            session_id,
            task_summary,
            parsed,
            nested_q,
            checkpointer,
        )

    return await run_coding_planner_deterministic_stream(
        session, session_id, task_summary, nested_q, checkpointer, include_lsp_discovery=include_lsp
    )
