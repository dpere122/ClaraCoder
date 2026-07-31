"""LangGraph-based tool agent via ``langchain.agents.create_agent``.

Standard Clara uses read/search plus staging and LSP tools when Editor is on. Per-connection ``parallel_tool_calls`` is applied via
:class:`~clara_coder_backend.parallel_tool_middleware.ConnectionParallelToolCallsMiddleware`.
Diff-review pauses use :class:`~clara_coder_backend.diff_review_middleware.DiffReviewAfterToolMiddleware`
plus a multiplexed event pump so diffs emit while the graph waits on ``POST /chat/agent-continue``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, AsyncIterator

from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig

from clara_coder_backend.lang_agent.streaming import sse_line, status_event
from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.accept_command import accept_command_sse_payload
from clara_coder_backend.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from clara_coder_backend.command_risk_assess import maybe_enrich_pending_command_risk
from clara_coder_backend.tools.review_tools import rollback_test_run_materializations
from clara_coder_backend.checkpointing import get_graph_checkpointer, outer_agent_thread_id
from clara_coder_backend.config import MAX_AGENT_STEPS
from clara_coder_backend.copy_review_middleware import CopyReviewAfterToolMiddleware
from clara_coder_backend.tools.copy import copy_confirm_sse_payload
from clara_coder_backend.tools.delete import delete_confirm_sse_payload
from clara_coder_backend.delete_review_middleware import DeleteReviewAfterToolMiddleware
from clara_coder_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from clara_coder_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from clara_coder_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from clara_coder_backend.pseudo_tool_xml_middleware import PseudoToolXmlMiddleware
from clara_coder_backend.tool_harness_feedback_middleware import prepend_harness_feedback_middleware
from clara_coder_backend.user_event_injection_middleware import UserEventInjectionMiddleware
from clara_coder_backend.user_events import drain_user_event_notes
from clara_coder_backend.chat_attachment_vision import prepare_chat_attachment_vision_turn
from clara_coder_backend.vision_tool_middleware import VisionImageInjectionMiddleware
from clara_coder_backend.staging_snapshot_session import cleanup_staging_snapshot_session
from clara_coder_backend.domain import SessionState
from clara_coder_backend.lang_agent.langgraph_sse import (
    GraphStreamState,
    sse_lines_for_graph_event,
)
from clara_coder_backend.llm import build_llm
from clara_coder_backend.llm_interaction_logging import log_llm_failure
from clara_coder_backend.messages import (
    build_system_prompt,
    compose_outer_turn_human_content,
    session_to_messages,
)
from clara_coder_backend.state import get_session
from clara_coder_backend.tool_registry import worker_tools_and_map

logger = logging.getLogger('clara.agent.langgraph')


def _stream_watchdog_timeout_sec() -> float:
    """Idle-stall watchdog interval: above the model idle read timeout so the clearer model-timeout
    error normally fires first; this is the last-resort backstop against an infinite silent hang."""
    from clara_coder_backend.llm import llm_idle_timeout_sec

    return llm_idle_timeout_sec() + 60.0


def _stream_is_genuinely_stalled(session: SessionState, main_state: GraphStreamState) -> bool:
    """True only when the stream is idle for a reason that should never persist.

    A tool currently running (``pending_tool_runs``) covers long-running tools (npm/pytest) and active HITL pauses
    (the tool node has not emitted ``on_tool_end`` yet). A HITL pause that is awaiting confirmation also keeps
    ``agent_pause_event`` set or a ``pending_*_request`` populated. In all those cases the idle wait is
    legitimate and the watchdog must not fire.
    """
    if main_state.pending_tool_runs:
        return False
    if session.agent_pause_event is not None:
        return False
    if (
        session.pending_delete_request
        or session.pending_copy_request
        or session.pending_accept_command_request
        or session.pending_staged_transfer_hitl is not None
    ):
        return False
    return True


def build_clara_single_outer_graph(
    llm: Any,
    session: SessionState,
    apply_mode: bool,
    *,
    extra_middleware: list[Any] | None = None,
    tools_provider: Callable[..., tuple[list[Any], dict[str, Any]]] | None = None,
) -> Any:
    """Same ``create_agent`` shape as the live Clara stream (checkpoint-compatible)."""
    if tools_provider is not None:
        tools, _ = tools_provider(apply_mode, session=session)
    else:
        tools, _ = worker_tools_and_map(apply_mode, session=session)
    system_prompt = build_system_prompt(session, apply_mode)
    core_middleware: list[Any] = [
        UserEventInjectionMiddleware(),
        ConnectionParallelToolCallsMiddleware(),
        PseudoToolXmlMiddleware(),
        EmptyResponseNudgeMiddleware(),
        VisionImageInjectionMiddleware(),
    ]
    if extra_middleware:
        core_middleware.extend(extra_middleware)
    core_middleware.append(AcceptCommandReviewAfterToolMiddleware())
    core_middleware.append(CopyReviewAfterToolMiddleware())
    core_middleware.append(DeleteReviewAfterToolMiddleware())
    core_middleware.append(DiffReviewAfterToolMiddleware())
    middleware = prepend_harness_feedback_middleware(core_middleware)
    return create_agent(
        llm,
        tools,
        system_prompt=system_prompt,
        name='clara_single',
        middleware=middleware,
        checkpointer=get_graph_checkpointer(),
    )


def _default_outer_graph_builder(
    llm: Any,
    session: SessionState,
    apply_mode: bool,
    extra_middleware: list[Any] | None,
) -> Any:
    return build_clara_single_outer_graph(llm, session, apply_mode, extra_middleware=extra_middleware)


def _cleanup_nested_edit_staging(session: SessionState, session_id: str) -> None:
    """Discard leftover staging after the outer agent turn finishes."""
    if session.pending_edit_stagings:
        logger.warning(
            'Orphaned edit stagings after outer agent completion (discarding): %s',
            list(session.pending_edit_stagings.keys()),
        )
    cleanup_staging_snapshot_session(session, session_id)


def _unpack_nested_queue_item(item: Any) -> tuple[str, dict[str, Any]] | None:
    """``(stream_tag, langgraph_v2_event_dict)`` from nested planning producers."""
    if isinstance(item, tuple) and len(item) == 2:
        tag, ev = item
        if isinstance(tag, str) and isinstance(ev, dict):
            return tag, ev
    return None


async def _cancel_pending_waiters(tasks: list[asyncio.Task[Any]]) -> None:
    """Cancel pending queue/event waiters used by the outer loop dispatcher."""

    for task in tasks:
        if task.done():
            continue
        task.cancel()
    for task in tasks:
        if task.done():
            continue
        try:
            await task
        except asyncio.CancelledError:
            pass


async def _race_stream_inputs(
    *queues: asyncio.Queue,
    labels: tuple[str, ...],
    abort_event: asyncio.Event,
    timeout: float | None = None,
) -> tuple[str, Any]:
    """Wait for the next queue item or an abort signal.

    When ``timeout`` elapses before any queue item or abort, return ``('watchdog', None)`` so the
    caller can decide whether the stream is genuinely stalled (see :func:`_stream_is_genuinely_stalled`).

    ``asyncio.wait(FIRST_COMPLETED)`` can report several ``q.get()`` tasks as done in the
    same batch (e.g. a HITL diff lands on ``hitl_q`` while the graph pump floods ``events_q``).
    Only one item can be returned per call, so any *other* completed get() tasks must have their
    items put back on their queues — otherwise they are consumed by the task and then lost when it
    is cancelled in ``finally``, which silently drops the diff and leaves the agent paused forever.
    Labels are ordered so earlier queues win (``hitl`` is prioritized by the caller's drain loop).
    """

    queue_tasks = [asyncio.create_task(q.get()) for q in queues]
    abort_task = asyncio.create_task(abort_event.wait())
    all_tasks = [*queue_tasks, abort_task]
    try:
        done, _pending = await asyncio.wait(
            all_tasks, return_when=asyncio.FIRST_COMPLETED, timeout=timeout
        )
        if not done:
            return 'watchdog', None
        if abort_task in done and abort_event.is_set():
            return 'abort', None
        selected: tuple[str, Any] | None = None
        for task, queue, label in zip(queue_tasks, queues, labels):
            if task not in done or task.cancelled() or task.exception() is not None:
                continue
            item = task.result()
            if selected is None:
                selected = (label, item)
            else:
                # Re-queue items we cannot return this round so they are not lost.
                queue.put_nowait(item)
        if selected is not None:
            return selected
        return 'abort', None
    finally:
        await _cancel_pending_waiters(all_tasks)


async def _hitl_sse_lines(session: SessionState, item: Any) -> list[str]:
    """Translate HITL queue signals into SSE payloads."""

    raw_hitl = item
    if raw_hitl == ('delete',):
        pending_delete = session.pending_delete_request
        if pending_delete:
            return [sse_line({'type': 'delete_confirm', 'deleteConfirm': delete_confirm_sse_payload(pending_delete)})]
        return []
    if raw_hitl == ('accept_command',):
        pending_cmd = session.pending_accept_command_request
        if pending_cmd:
            await maybe_enrich_pending_command_risk(pending_cmd)
            return [
                sse_line({'type': 'accept_command', 'acceptCommand': accept_command_sse_payload(pending_cmd)})
            ]
        return []
    if raw_hitl == ('copy',):
        pending_copy = session.pending_copy_request
        if pending_copy:
            return [sse_line({'type': 'copy_confirm', 'copyConfirm': copy_confirm_sse_payload(pending_copy)})]
        return []
    if isinstance(raw_hitl, tuple) and raw_hitl and raw_hitl[0] == 'diff':
        pending_diff = raw_hitl[1] if len(raw_hitl) > 1 else session.pending_diff_payload
        if pending_diff:
            session.pending_diff_payload = None
            return [sse_line({'type': 'diff', 'diff': pending_diff})]
        return []
    if isinstance(raw_hitl, tuple) and raw_hitl and raw_hitl[0] == 'staged_transfer_batch':
        batch = raw_hitl[1] if len(raw_hitl) > 1 else session.pending_staged_transfer_batch_payload
        if batch:
            session.pending_staged_transfer_batch_payload = None
            return [sse_line({'type': 'staged_transfer_batch', 'stagedTransferBatch': batch})]
        return []
    return []


def _nested_sse_lines(
    session: SessionState,
    item: Any,
    *,
    nested_states: dict[str, GraphStreamState],
    cfg: AgentGraphConfig,
) -> list[str]:
    """Translate nested subprocess/tool queue items into outer SSE lines."""

    unpacked = _unpack_nested_queue_item(item)
    if unpacked is None:
        return []
    tag, ev = unpacked
    if ev.get('event') == 'planner_progress':
        data = ev.get('data')
        if isinstance(data, dict):
            from clara_coder_backend.lang_agent.streaming import planner_progress_event, sse_line

            planner = data.get('planner') if isinstance(data.get('planner'), dict) else data
            return [sse_line(planner_progress_event(planner))]
        return []
    nested_state = nested_states.setdefault(tag, GraphStreamState())
    return list(
        sse_lines_for_graph_event(
            ev,
            nested_state,
            agent_role=None,
            status_label='Workspace',
            llm_event_prefix='nest',
            llm_log_context=f'{cfg.graph_name}:nested',
            stream_tag=tag,
            emit_model_token_sse=False,
        )
    )


def _graph_sse_lines(
    session: SessionState,
    ev: dict[str, Any],
    *,
    main_state: GraphStreamState,
    cfg: AgentGraphConfig,
    main_stream_tag: str,
) -> list[str]:
    """Translate one outer graph event into SSE lines and state updates."""

    emit_parent_tokens = not session.suppress_parent_graph_model_token_sse
    return list(
        sse_lines_for_graph_event(
            ev,
            main_state,
            agent_role=cfg.agent_role,
            status_label=cfg.status_label,
            llm_event_prefix=cfg.llm_event_prefix,
            llm_log_context=cfg.graph_name,
            stream_tag=main_stream_tag,
            emit_model_token_sse=emit_parent_tokens,
            record_model_end_final_text=emit_parent_tokens,
        )
    )


@dataclass
class AgentGraphConfig:
    """Bundled parameters for :func:`_stream_langgraph_tool_agent`."""

    session_id: str
    graph_name: str
    agent_role: str | None
    status_label: str
    llm_event_prefix: str
    config_error_event_id: str
    run_error_event_id: str
    done_event_id: str
    empty_final_user_hint: str
    failed_start_message: str
    failed_run_message: str
    thread_kind: str
    done_detail: str
    #: When set, used for LangGraph ``thread_id`` instead of ``session_id`` (per-step executor isolation).
    checkpoint_session_key: str | None = None


async def _stream_langgraph_tool_agent(
    session: SessionState,
    apply_mode: bool,
    user_message: str | list[dict[str, Any]],
    *,
    cfg: AgentGraphConfig,
    outcome: LangGraphWorkerOutcome,
    extra_middleware: list[Any] | None = None,
    nested_planning_queue: asyncio.Queue | None = None,
    resume_checkpoint_id: str | None = None,
    outer_graph_builder: Callable[[Any, SessionState, bool, list[Any] | None], Any] | None = None,
) -> AsyncIterator[str]:
    """Run create_agent graph; yield SSE.

    ``worker_apply_mode`` and ``hitl_sse_queue`` are refcounted across concurrent
    streams for the same session so a finished stream cannot clear Editor mode or
    shared queues while another stream is still running (e.g. overlapping fetches).
    """
    try:
        llm = build_llm()
    except Exception as exc:
        log_llm_failure(exc, context=f'{cfg.graph_name}:bootstrap', agent_role=cfg.agent_role)
        yield sse_line(
            status_event(
                cfg.config_error_event_id,
                'Configuration issue',
                detail=str(exc).replace('\n', ' ')[:200],
                state='error',
                agent_role=cfg.agent_role,
            )
        )
        outcome.mark_failed_configuration(
            str(exc),
            final_text=cfg.failed_start_message.format(exc=exc),
        )
        return

    _graph_make = outer_graph_builder or _default_outer_graph_builder
    graph = _graph_make(llm, session, apply_mode, extra_middleware)
    thread_id = outer_agent_thread_id(
        cfg.checkpoint_session_key or cfg.session_id,
        cfg.thread_kind,
        apply_mode=apply_mode,
    )
    rec_lim = MAX_AGENT_STEPS
    config: RunnableConfig = {
        'configurable': {'thread_id': thread_id},
        'recursion_limit': rec_lim,
    }
    rid = (resume_checkpoint_id or '').strip()
    if rid:
        config['configurable']['checkpoint_id'] = rid

    prior = await graph.aget_state(config)
    vals = getattr(prior, 'values', None) or {}
    existing = vals.get('messages') if isinstance(vals, dict) else None
    has_checkpoint_messages = bool(existing)

    human_content = compose_outer_turn_human_content(session, apply_mode, user_message)
    human_content = prepare_chat_attachment_vision_turn(human_content)
    pending_event_messages = [HumanMessage(content=note) for note in drain_user_event_notes(session)]
    if has_checkpoint_messages:
        input_messages: list[Any] = [*pending_event_messages, HumanMessage(content=human_content)]
    else:
        input_messages = [
            *session_to_messages(session),
            *pending_event_messages,
            HumanMessage(content=human_content),
        ]
    inputs: dict[str, Any] = {'messages': input_messages}

    events_q: asyncio.Queue = asyncio.Queue()
    hitl_q: asyncio.Queue = asyncio.Queue()

    async def pump_events() -> None:
        try:
            async for ev in graph.astream_events(inputs, config, version='v2'):
                await events_q.put(ev)
        finally:
            await events_q.put(None)

    main_state = GraphStreamState()
    nested_states: dict[str, GraphStreamState] = {}
    main_stream_tag = 'agent'
    # Subprocess / nested tool streaming (pytest, smoke, overlay) shares one queue.
    # Outer chat streams always allocate a queue so project-review tools can emit tool_exec_* SSE.
    nested_stream_q = nested_planning_queue if nested_planning_queue is not None else asyncio.Queue()

    session.active_langgraph_agent_streams += 1
    if apply_mode:
        session.active_editor_langgraph_streams += 1
    session.worker_apply_mode = session.active_editor_langgraph_streams > 0
    # Assign before ``pump_events`` so diff/copy/delete middleware can queue HITL on the first tool turn.
    session.hitl_sse_queue = hitl_q
    session.planning_nested_events_q = nested_stream_q

    pump_task = asyncio.create_task(pump_events())

    queues = (events_q, hitl_q, nested_stream_q)
    queue_labels = ('ev', 'hitl', 'nested')
    watchdog_timeout = _stream_watchdog_timeout_sec()

    try:
        try:
            while True:
                try:
                    item = hitl_q.get_nowait()
                    kind = 'hitl'
                except asyncio.QueueEmpty:
                    kind, item = await _race_stream_inputs(
                        *queues,
                        labels=queue_labels,
                        abort_event=session.abort_event,
                        timeout=watchdog_timeout,
                    )

                if kind == 'abort':
                    outcome.mark_aborted(partial_text=main_state.partial_stream_text)
                    break

                if kind == 'watchdog':
                    if not _stream_is_genuinely_stalled(session, main_state):
                        # Long-running tool, nested specialist, or HITL pause in progress: keep waiting.
                        continue
                    logger.warning(
                        'Stream stall watchdog tripped (%s): no progress for %.0fs with no active '
                        'tool or HITL pause; ending stream.',
                        cfg.graph_name,
                        watchdog_timeout,
                    )
                    yield sse_line(
                        status_event(
                            cfg.run_error_event_id,
                            cfg.status_label,
                            detail=(
                                'The agent stopped producing output and appears stalled '
                                f'(no activity for {int(watchdog_timeout)}s). Please try again.'
                            ),
                            state='error',
                            agent_role=cfg.agent_role,
                        )
                    )
                    outcome.mark_failed_runtime(
                        'stream stall watchdog: no progress and no active tool/HITL pause',
                        final_text=cfg.failed_run_message.format(exc='stream stalled (watchdog timeout)'),
                        partial_text=main_state.partial_stream_text,
                    )
                    break

                if kind == 'hitl':
                    for line in await _hitl_sse_lines(get_session(cfg.session_id), item):
                        yield line
                    continue

                if kind == 'nested':
                    for line in _nested_sse_lines(
                        session,
                        item,
                        nested_states=nested_states,
                        cfg=cfg,
                    ):
                        yield line
                    continue

                if item is None:
                    break

                ev = item
                assert isinstance(ev, dict)
                for line in _graph_sse_lines(
                    session,
                    ev,
                    main_state=main_state,
                    cfg=cfg,
                    main_stream_tag=main_stream_tag,
                ):
                    yield line
                outcome.partial_text = main_state.partial_stream_text
            # Aborts and the stall watchdog break out while ``pump_task`` is still blocked inside
            # ``astream_events`` (e.g. a hung model call); cancel rather than await it forever.
            if outcome.state in (AgentLoopOutcome.ABORTED, AgentLoopOutcome.FAILED_RUNTIME):
                if not pump_task.done():
                    pump_task.cancel()
                try:
                    await pump_task
                except asyncio.CancelledError:
                    pass
            else:
                await pump_task
        except Exception as exc:
            logger.exception('LangGraph agent failed (%s)', cfg.graph_name)
            log_llm_failure(exc, context=cfg.graph_name, agent_role=cfg.agent_role)
            yield sse_line(
                status_event(
                    cfg.run_error_event_id,
                    cfg.status_label,
                    detail=f'{type(exc).__name__}: {exc}',
                    state='error',
                    agent_role=cfg.agent_role,
                )
            )
            outcome.mark_failed_runtime(
                f'{type(exc).__name__}: {exc}',
                final_text=cfg.failed_run_message.format(exc=exc),
                partial_text=main_state.partial_stream_text,
            )
        else:
            outcome.partial_text = main_state.partial_stream_text
            if outcome.state == AgentLoopOutcome.ABORTED:
                outcome.mark_aborted(partial_text=main_state.partial_stream_text)
            elif outcome.state == AgentLoopOutcome.FAILED_RUNTIME:
                # Stall watchdog already reported the failure; do not overwrite it with a completion.
                pass
            else:
                final_text = main_state.last_final_text
                if not final_text.strip():
                    final_text = cfg.empty_final_user_hint
                outcome.mark_completed(
                    final_text=final_text,
                    partial_text=main_state.partial_stream_text,
                )
                yield sse_line(
                    status_event(
                        cfg.done_event_id,
                        cfg.status_label,
                        detail=cfg.done_detail,
                        state='complete',
                        source='agent',
                        agent_role=cfg.agent_role,
                    )
                )
    finally:
        if apply_mode:
            session.active_editor_langgraph_streams = max(0, session.active_editor_langgraph_streams - 1)
        session.worker_apply_mode = session.active_editor_langgraph_streams > 0
        session.active_langgraph_agent_streams = max(0, session.active_langgraph_agent_streams - 1)
        if session.active_langgraph_agent_streams == 0:
            _cleanup_nested_edit_staging(session, cfg.session_id)
            session.hitl_sse_queue = None
            session.planning_nested_events_q = None
        if not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass


async def stream_single_agent_langgraph(
    session: SessionState,
    user_message: str | list[dict[str, Any]],
    apply_mode: bool,
    *,
    session_id: str,
    outcome: LangGraphWorkerOutcome,
    resume_checkpoint_id: str | None = None,
) -> AsyncIterator[str]:
    """Clara: full chat + user turn via the outer tool graph."""
    cfg = AgentGraphConfig(
        session_id=session_id,
        graph_name='clara_single',
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        config_error_event_id='agent-graph',
        run_error_event_id='agent-graph-error',
        done_event_id='agent-done',
        empty_final_user_hint=(
            'The agent finished without a final text response. '
            'Try rephrasing the request.'
        ),
        failed_start_message='Agent failed to start: {exc}',
        failed_run_message='Agent error: {exc}',
        thread_kind='single',
        done_detail='Complete',
    )

    async for line in _stream_langgraph_tool_agent(
        session,
        apply_mode,
        user_message,
        cfg=cfg,
        outcome=outcome,
        resume_checkpoint_id=resume_checkpoint_id,
    ):
        yield line
