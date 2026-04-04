"""LangGraph-based tool agents via ``langchain.agents.create_agent``.

Used for the delegated workspace worker, single-agent mode, and (with manager/worker) the
manager agent. Streams SSE like the classic loop. Per-connection ``parallel_tool_calls``
is applied via :class:`~nemo_backend.parallel_tool_middleware.ConnectionParallelToolCallsMiddleware`.
Diff-review pauses use :class:`~nemo_backend.diff_review_middleware.DiffReviewAfterToolMiddleware`
plus a multiplexed event pump so diffs emit while the graph waits on ``POST /chat/agent-continue``.

Manager mode adds :class:`~nemo_backend.delegate_nested_worker_middleware.DelegateNestedWorkerMiddleware`
and a third queue so nested worker ``astream_events`` merge into the same SSE response during
``delegate_workspace_task``.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver

from nemo_backend.agent_streaming import (
    aimessage_chunk_sse_delta,
    is_meaningful_stream_delta,
    iter_read_tool_stream_sse,
    sse_line,
    sse_tool_finished,
    status_event,
    tool_running_detail,
)
from nemo_backend.config import MAX_AGENT_STEPS
from nemo_backend.delegate_nested_worker_middleware import (
    NESTED_WORKER_STREAM_END,
    DelegateNestedWorkerMiddleware,
)
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from nemo_backend.domain import SessionState
from nemo_backend.llm import build_llm
from nemo_backend.messages import (
    build_manager_system_prompt,
    build_system_prompt,
    build_worker_system_prompt,
    final_assistant_text,
    session_to_messages,
    stringify_content,
)
from nemo_backend.state import get_session
from nemo_backend.tool_registry import manager_tools_and_map, worker_tools_and_map

logger = logging.getLogger('nemo.agent.langgraph')

_GRAPH_CHECKPOINTER = MemorySaver()


@dataclass
class LangGraphWorkerOutcome:
    final_text: str = ''


@dataclass
class _GraphStreamState:
    pending_tool_runs: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    last_final_text: str = ''
    llm_step: int = 0


def _tool_output_text(raw: Any) -> tuple[str, bool, str]:
    """Return (text, ok, error_detail)."""
    if isinstance(raw, Exception):
        return '', False, f'{type(raw).__name__}: {raw}'
    if isinstance(raw, ToolMessage):
        return stringify_content(raw.content), True, ''
    if raw is None:
        return '', True, ''
    if isinstance(raw, str):
        return raw, True, ''
    return str(raw), True, ''


def _sse_lines_for_graph_event(
    ev: dict[str, Any],
    state: _GraphStreamState,
    *,
    agent_role: str | None,
    status_label: str,
    llm_event_prefix: str,
) -> list[str]:
    """Map one LangGraph v2 stream event to SSE JSON lines (side effect: updates ``state``)."""
    lines: list[str] = []
    et = ev.get('event')
    data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
    if et == 'on_chat_model_start':
        state.llm_step += 1
        lines.append(
            sse_line(
                status_event(
                    f'{llm_event_prefix}-{state.llm_step}',
                    status_label,
                    detail='Thinking…',
                    state='running',
                    source='agent',
                    agent_role=agent_role,
                )
            )
        )
    elif et == 'on_chat_model_stream':
        raw = data.get('chunk')
        if isinstance(raw, AIMessageChunk):
            delta = aimessage_chunk_sse_delta(raw)
            if is_meaningful_stream_delta(delta):
                lines.append(sse_line({'type': 'chunk', 'delta': delta}))
    elif et == 'on_chat_model_end':
        raw = data.get('output')
        msg = raw if isinstance(raw, AIMessage) else None
        if msg is not None:
            lines.append(
                sse_line(
                    status_event(
                        f'{llm_event_prefix}-{state.llm_step}',
                        status_label,
                        detail='',
                        state='complete',
                        source='agent',
                        agent_role=agent_role,
                    )
                )
            )
            if not (msg.tool_calls or []):
                state.last_final_text = final_assistant_text(msg)
    elif et == 'on_tool_start':
        name = str(ev.get('name') or 'tool')
        raw_input = data.get('input')
        args: dict[str, Any] = raw_input if isinstance(raw_input, dict) else {}
        run_id = str(ev.get('run_id') or uuid.uuid4().hex[:12])
        state.pending_tool_runs[run_id] = (name, args)
        lines.append(
            sse_line(
                status_event(
                    run_id,
                    name,
                    detail=tool_running_detail(name, args),
                    state='running',
                    source='tool',
                    agent_role=agent_role,
                )
            )
        )
    elif et == 'on_tool_end':
        name = str(ev.get('name') or 'tool')
        run_id = str(ev.get('run_id') or '')
        state.pending_tool_runs.pop(run_id, (name, {}))
        raw_out = data.get('output')
        result_text, ok, err_detail = _tool_output_text(raw_out)
        for stream_line_ in iter_read_tool_stream_sse(name, result_text):
            lines.append(stream_line_)
        lines.append(
            sse_tool_finished(
                run_id or name,
                name,
                result_text,
                ok=ok,
                error_detail=err_detail,
                agent_role=agent_role,
            )
        )
    return lines


async def _race_queue_get(events_q: asyncio.Queue, hitl_q: asyncio.Queue) -> tuple[str, Any]:
    """Wait for the first item from either queue; cancel the loser. Returns ('ev', item) or ('hitl', _)."""
    t_ev = asyncio.create_task(events_q.get())
    t_hi = asyncio.create_task(hitl_q.get())
    done, pending = await asyncio.wait({t_ev, t_hi}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
    finished = next(iter(done))
    if finished is t_ev:
        return 'ev', t_ev.result()
    return 'hitl', t_hi.result()


async def _race_queue_get_three(
    events_q: asyncio.Queue,
    hitl_q: asyncio.Queue,
    nested_q: asyncio.Queue,
) -> tuple[str, Any]:
    """Like :func:`_race_queue_get` plus a nested worker delegate queue."""
    t_ev = asyncio.create_task(events_q.get())
    t_hi = asyncio.create_task(hitl_q.get())
    t_n = asyncio.create_task(nested_q.get())
    done, pending = await asyncio.wait({t_ev, t_hi, t_n}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
    finished = next(iter(done))
    if finished is t_ev:
        return 'ev', t_ev.result()
    if finished is t_hi:
        return 'hitl', t_hi.result()
    return 'nested', t_n.result()


async def _stream_langgraph_tool_agent(
    session: SessionState,
    tools: list[Any],
    system_prompt: str,
    input_messages: list[BaseMessage],
    apply_mode: bool,
    *,
    session_id: str,
    outcome: LangGraphWorkerOutcome,
    graph_name: str,
    agent_role: str | None,
    status_label: str,
    llm_event_prefix: str,
    config_error_event_id: str,
    run_error_event_id: str,
    done_event_id: str,
    empty_final_user_hint: str,
    failed_start_message: str,
    failed_run_message: str,
    thread_kind: str,
    done_detail: str,
    extra_middleware: list[Any] | None = None,
    nested_delegate_queue: asyncio.Queue | None = None,
) -> AsyncIterator[str]:
    """Run create_agent graph; yield SSE. Sets ``worker_apply_mode`` / ``hitl_sse_queue`` for diff middleware."""
    try:
        llm = build_llm()
    except Exception as exc:
        yield sse_line(
            status_event(
                config_error_event_id,
                'Configuration issue',
                detail=str(exc).replace('\n', ' ')[:200],
                state='error',
                agent_role=agent_role,
            )
        )
        outcome.final_text = failed_start_message.format(exc=exc)
        return

    middleware: list[Any] = [ConnectionParallelToolCallsMiddleware()]
    if extra_middleware:
        middleware.extend(extra_middleware)
    middleware.append(DiffReviewAfterToolMiddleware())

    graph = create_agent(
        llm,
        tools,
        system_prompt=system_prompt,
        name=graph_name,
        middleware=middleware,
        checkpointer=_GRAPH_CHECKPOINTER,
    )
    thread_id = f'{session_id}:{thread_kind}:{uuid.uuid4().hex[:10]}'
    config: RunnableConfig = {
        'configurable': {'thread_id': thread_id},
        'recursion_limit': MAX_AGENT_STEPS,
    }
    inputs: dict[str, Any] = {'messages': input_messages}

    events_q: asyncio.Queue = asyncio.Queue()
    hitl_q: asyncio.Queue = asyncio.Queue()
    session.worker_apply_mode = apply_mode
    session.hitl_sse_queue = hitl_q
    if nested_delegate_queue is not None:
        session.delegate_nested_events_q = nested_delegate_queue

    async def pump_events() -> None:
        try:
            async for ev in graph.astream_events(inputs, config, version='v2'):
                await events_q.put(ev)
        finally:
            await events_q.put(None)

    main_state = _GraphStreamState()
    nested_state = _GraphStreamState()
    pump_task = asyncio.create_task(pump_events())

    try:
        try:
            while True:
                if nested_delegate_queue is not None:
                    kind, item = await _race_queue_get_three(events_q, hitl_q, nested_delegate_queue)
                else:
                    kind, item = await _race_queue_get(events_q, hitl_q)

                if kind == 'hitl':
                    sess = get_session(session_id)
                    pending = sess.pending_diff_payload
                    if pending:
                        yield sse_line({'type': 'diff', 'diff': pending})
                        sess.pending_diff_payload = None
                    continue

                if kind == 'nested':
                    if item is NESTED_WORKER_STREAM_END:
                        done_ev = session.delegate_nested_done_event
                        if done_ev is not None:
                            done_ev.set()
                        nested_state = _GraphStreamState()
                        continue
                    ev = item
                    assert isinstance(ev, dict)
                    for line in _sse_lines_for_graph_event(
                        ev,
                        nested_state,
                        agent_role='worker',
                        status_label='Worker',
                        llm_event_prefix='wkr',
                    ):
                        yield line
                    continue

                if item is None:
                    break

                ev = item
                assert isinstance(ev, dict)
                for line in _sse_lines_for_graph_event(
                    ev,
                    main_state,
                    agent_role=agent_role,
                    status_label=status_label,
                    llm_event_prefix=llm_event_prefix,
                ):
                    yield line
            await pump_task
        except Exception as exc:
            logger.exception('LangGraph agent failed (%s)', graph_name)
            yield sse_line(
                status_event(
                    run_error_event_id,
                    status_label,
                    detail=f'{type(exc).__name__}: {exc}',
                    state='error',
                    agent_role=agent_role,
                )
            )
            outcome.final_text = failed_run_message.format(exc=exc)
        else:
            if not main_state.last_final_text.strip():
                main_state.last_final_text = empty_final_user_hint
            outcome.final_text = main_state.last_final_text
            yield sse_line(
                status_event(
                    done_event_id,
                    status_label,
                    detail=done_detail,
                    state='complete',
                    source='agent',
                    agent_role=agent_role,
                )
            )
    finally:
        session.worker_apply_mode = False
        session.hitl_sse_queue = None
        session.delegate_nested_events_q = None
        session.delegate_nested_done_event = None
        if not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass


async def stream_worker_langgraph(
    session: SessionState,
    task_summary: str,
    apply_mode: bool,
    *,
    session_id: str,
    outcome: LangGraphWorkerOutcome,
) -> AsyncIterator[str]:
    """Run the delegated workspace worker as a LangGraph agent; yield SSE lines (status + optional diff)."""
    tools, _ = worker_tools_and_map(apply_mode)
    system_prompt = build_worker_system_prompt(session, apply_mode)
    input_messages = [HumanMessage(content=f'Task:\n{task_summary.strip()}')]
    async for line in _stream_langgraph_tool_agent(
        session,
        tools,
        system_prompt,
        input_messages,
        apply_mode,
        session_id=session_id,
        outcome=outcome,
        graph_name='nemo_worker',
        agent_role='worker',
        status_label='Worker',
        llm_event_prefix='worker-llm',
        config_error_event_id='worker-graph',
        run_error_event_id='worker-graph-error',
        done_event_id='worker-done',
        empty_final_user_hint=(
            'The workspace worker finished without a final text response. '
            'Try rephrasing the task or set NEMO_USE_LANGGRAPH_AGENT=false to use the classic worker.'
        ),
        failed_start_message='Worker failed to start: {exc}',
        failed_run_message='Worker error: {exc}',
        thread_kind='worker',
        done_detail='Task complete',
    ):
        yield line


async def stream_single_agent_langgraph(
    session: SessionState,
    user_message: str,
    apply_mode: bool,
    *,
    session_id: str,
    outcome: LangGraphWorkerOutcome,
) -> AsyncIterator[str]:
    """Single-agent Clara: full chat history + user turn via LangGraph; yield SSE like the classic loop."""
    tools, _ = worker_tools_and_map(apply_mode)
    system_prompt = build_system_prompt(session, apply_mode)
    input_messages = [*session_to_messages(session), HumanMessage(content=user_message)]
    async for line in _stream_langgraph_tool_agent(
        session,
        tools,
        system_prompt,
        input_messages,
        apply_mode,
        session_id=session_id,
        outcome=outcome,
        graph_name='nemo_single',
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        config_error_event_id='agent-graph',
        run_error_event_id='agent-graph-error',
        done_event_id='agent-done',
        empty_final_user_hint=(
            'The agent finished without a final text response. '
            'Try rephrasing the request or set NEMO_USE_LANGGRAPH_AGENT=false to use the classic agent loop.'
        ),
        failed_start_message='Agent failed to start: {exc}',
        failed_run_message='Agent error: {exc}',
        thread_kind='single',
        done_detail='Complete',
    ):
        yield line


async def stream_manager_langgraph(
    session: SessionState,
    user_message: str,
    apply_mode: bool,
    *,
    session_id: str,
    outcome: LangGraphWorkerOutcome,
) -> AsyncIterator[str]:
    """Manager Clara: reads + optional delegation via LangGraph; nested worker SSE merges into this stream."""
    nested_q: asyncio.Queue = asyncio.Queue()
    tools, _ = manager_tools_and_map(apply_mode)
    system_prompt = build_manager_system_prompt(session, apply_mode)
    input_messages = [*session_to_messages(session), HumanMessage(content=user_message)]
    async for line in _stream_langgraph_tool_agent(
        session,
        tools,
        system_prompt,
        input_messages,
        apply_mode,
        session_id=session_id,
        outcome=outcome,
        graph_name='nemo_manager',
        agent_role='manager',
        status_label='Manager',
        llm_event_prefix='mgr',
        config_error_event_id='manager-graph',
        run_error_event_id='manager-graph-error',
        done_event_id='manager-done',
        empty_final_user_hint=(
            'The manager finished without a final text response. '
            'Try rephrasing the request or set NEMO_USE_LANGGRAPH_AGENT=false for the classic manager loop.'
        ),
        failed_start_message='Manager failed to start: {exc}',
        failed_run_message='Manager error: {exc}',
        thread_kind='manager',
        done_detail='Complete',
        extra_middleware=[DelegateNestedWorkerMiddleware(_GRAPH_CHECKPOINTER)],
        nested_delegate_queue=nested_q,
    ):
        yield line
