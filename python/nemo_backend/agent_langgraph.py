"""LangGraph-based tool agent via ``langchain.agents.create_agent``.

Single outer Clara with read/search + optional ``modify_workspace``. Nested router/specialists
stream on a side queue during planning. Per-connection ``parallel_tool_calls`` is applied via
:class:`~nemo_backend.parallel_tool_middleware.ConnectionParallelToolCallsMiddleware`.
Diff-review pauses use :class:`~nemo_backend.diff_review_middleware.DiffReviewAfterToolMiddleware`
plus a multiplexed event pump so diffs emit while the graph waits on ``POST /chat/agent-continue``.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator

from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver

from nemo_backend.agent_streaming import sse_line, status_event
from nemo_backend.agents.planning.nested_middleware import (
    NESTED_WORKER_STREAM_END,
    PlanningNestedWorkerMiddleware,
)
from nemo_backend.config import MAX_AGENT_STEPS
from nemo_backend.delete_tool import delete_confirm_sse_payload
from nemo_backend.delete_review_middleware import DeleteReviewAfterToolMiddleware
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from nemo_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from nemo_backend.domain import SessionState
from nemo_backend.langgraph_sse import (
    GraphStreamState,
    race_queues,
    sse_lines_for_graph_event,
)
from nemo_backend.llm import build_llm
from nemo_backend.llm_interaction_logging import log_llm_failure
from nemo_backend.messages import build_system_prompt, session_to_messages
from nemo_backend.state import get_session
from nemo_backend.tool_registry import worker_tools_and_map

logger = logging.getLogger('nemo.agent.langgraph')

_GRAPH_CHECKPOINTER = MemorySaver()


def _unpack_nested_queue_item(item: Any) -> tuple[str, dict[str, Any]] | None:
    """``(stream_tag, langgraph_v2_event_dict)`` from nested planning producers."""
    if isinstance(item, tuple) and len(item) == 2:
        tag, ev = item
        if isinstance(tag, str) and isinstance(ev, dict):
            return tag, ev
    return None


@dataclass
class LangGraphWorkerOutcome:
    final_text: str = ''


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


async def _stream_langgraph_tool_agent(
    session: SessionState,
    tools: list[Any],
    system_prompt: str,
    input_messages: list[Any],
    apply_mode: bool,
    *,
    cfg: AgentGraphConfig,
    outcome: LangGraphWorkerOutcome,
    extra_middleware: list[Any] | None = None,
    nested_planning_queue: asyncio.Queue | None = None,
) -> AsyncIterator[str]:
    """Run create_agent graph; yield SSE. Sets ``worker_apply_mode`` / ``hitl_sse_queue`` for diff middleware."""
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
        outcome.final_text = cfg.failed_start_message.format(exc=exc)
        return

    middleware: list[Any] = [ConnectionParallelToolCallsMiddleware(), EmptyResponseNudgeMiddleware()]
    if extra_middleware:
        middleware.extend(extra_middleware)
    middleware.append(DeleteReviewAfterToolMiddleware())
    middleware.append(DiffReviewAfterToolMiddleware())

    graph = create_agent(
        llm,
        tools,
        system_prompt=system_prompt,
        name=cfg.graph_name,
        middleware=middleware,
        checkpointer=_GRAPH_CHECKPOINTER,
    )
    thread_id = f'{cfg.session_id}:{cfg.thread_kind}:{uuid.uuid4().hex[:10]}'
    config: RunnableConfig = {
        'configurable': {'thread_id': thread_id},
        'recursion_limit': MAX_AGENT_STEPS,
    }
    inputs: dict[str, Any] = {'messages': input_messages}

    events_q: asyncio.Queue = asyncio.Queue()
    hitl_q: asyncio.Queue = asyncio.Queue()
    session.worker_apply_mode = apply_mode
    session.hitl_sse_queue = hitl_q
    if nested_planning_queue is not None:
        session.planning_nested_events_q = nested_planning_queue

    async def pump_events() -> None:
        try:
            async for ev in graph.astream_events(inputs, config, version='v2'):
                await events_q.put(ev)
        finally:
            await events_q.put(None)

    main_state = GraphStreamState()
    nested_states: dict[str, GraphStreamState] = {}
    main_stream_tag = 'agent'
    pump_task = asyncio.create_task(pump_events())

    queue_labels: tuple[str, ...]
    queues: tuple[asyncio.Queue, ...]
    if nested_planning_queue is not None:
        queues = (events_q, hitl_q, nested_planning_queue)
        queue_labels = ('ev', 'hitl', 'nested')
    else:
        queues = (events_q, hitl_q)
        queue_labels = ('ev', 'hitl')

    try:
        try:
            while True:
                kind, item = await race_queues(*queues, labels=queue_labels)

                if kind == 'hitl':
                    sess = get_session(cfg.session_id)
                    raw_hitl = item
                    if raw_hitl == ('delete',):
                        pd = sess.pending_delete_request
                        if pd:
                            yield sse_line(
                                {'type': 'delete_confirm', 'deleteConfirm': delete_confirm_sse_payload(pd)}
                            )
                    else:
                        pending = sess.pending_diff_payload
                        if pending:
                            yield sse_line({'type': 'diff', 'diff': pending})
                            sess.pending_diff_payload = None
                    continue

                if kind == 'nested':
                    if item is NESTED_WORKER_STREAM_END:
                        done_ev = session.planning_nested_done_event
                        if done_ev is not None:
                            done_ev.set()
                        nested_states.clear()
                        continue
                    unpacked = _unpack_nested_queue_item(item)
                    if unpacked is None:
                        continue
                    tag, ev = unpacked
                    st = nested_states.setdefault(tag, GraphStreamState())
                    for line in sse_lines_for_graph_event(
                        ev,
                        st,
                        agent_role=None,
                        status_label='Workspace',
                        llm_event_prefix='nest',
                        llm_log_context=f'{cfg.graph_name}:nested',
                        stream_tag=tag,
                        emit_model_token_sse=False,
                    ):
                        yield line
                    continue

                if item is None:
                    break

                ev = item
                assert isinstance(ev, dict)
                emit_parent_tokens = not session.suppress_parent_graph_model_token_sse
                for line in sse_lines_for_graph_event(
                    ev,
                    main_state,
                    agent_role=cfg.agent_role,
                    status_label=cfg.status_label,
                    llm_event_prefix=cfg.llm_event_prefix,
                    llm_log_context=cfg.graph_name,
                    stream_tag=main_stream_tag,
                    emit_model_token_sse=emit_parent_tokens,
                    record_model_end_final_text=emit_parent_tokens,
                ):
                    yield line
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
            outcome.final_text = cfg.failed_run_message.format(exc=exc)
        else:
            if not main_state.last_final_text.strip():
                main_state.last_final_text = cfg.empty_final_user_hint
            outcome.final_text = main_state.last_final_text
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
        session.worker_apply_mode = False
        session.hitl_sse_queue = None
        session.planning_nested_events_q = None
        session.planning_nested_done_event = None
        if not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass


async def stream_single_agent_langgraph(
    session: SessionState,
    user_message: str,
    apply_mode: bool,
    *,
    session_id: str,
    outcome: LangGraphWorkerOutcome,
) -> AsyncIterator[str]:
    """Clara: full chat + user turn; nested router/specialists stream during ``modify_workspace``."""
    nested_q: asyncio.Queue = asyncio.Queue()
    tools, _ = worker_tools_and_map(apply_mode)
    system_prompt = build_system_prompt(session, apply_mode)
    input_messages = [*session_to_messages(session), HumanMessage(content=user_message)]

    cfg = AgentGraphConfig(
        session_id=session_id,
        graph_name='nemo_single',
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
        tools,
        system_prompt,
        input_messages,
        apply_mode,
        cfg=cfg,
        outcome=outcome,
        extra_middleware=[PlanningNestedWorkerMiddleware(_GRAPH_CHECKPOINTER)],
        nested_planning_queue=nested_q,
    ):
        yield line
