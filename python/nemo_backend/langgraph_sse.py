"""Map LangGraph v2 stream events to SSE JSON lines and async queue racing helpers.

Extracted from :mod:`nemo_backend.agent_langgraph` for readability and testability.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from nemo_backend.agent_streaming import (
    aimessage_chunk_sse_delta,
    is_meaningful_stream_delta,
    iter_read_tool_stream_sse,
    model_chunk_sse_line,
    sse_line,
    sse_tool_finished,
    status_event,
    tool_running_detail,
)
from nemo_backend.llm_interaction_logging import (
    log_llm_chat_request_from_event_input,
    log_llm_chat_response,
)
from nemo_backend.messages import final_assistant_text, stringify_content
from nemo_backend.tool_call_logging import log_llm_tool_input, log_llm_tool_output


@dataclass
class GraphStreamState:
    """Mutable per-stream counters for SSE event mapping."""

    pending_tool_runs: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    last_final_text: str = ''
    llm_step: int = 0
    stream_chunks: int = 0
    stream_chars: int = 0


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


# ---------------------------------------------------------------------------
# Per-event-type handlers
# ---------------------------------------------------------------------------

def _on_chat_model_start(
    data: dict[str, Any],
    state: GraphStreamState,
    *,
    agent_role: str | None,
    status_label: str,
    llm_event_prefix: str,
    llm_log_context: str,
) -> list[str]:
    state.llm_step += 1
    state.stream_chunks = 0
    state.stream_chars = 0
    log_llm_chat_request_from_event_input(
        data.get('input'),
        context=llm_log_context,
        agent_role=agent_role,
        llm_step=state.llm_step,
    )
    return [
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
    ]


def _on_chat_model_stream(
    data: dict[str, Any],
    state: GraphStreamState,
    *,
    stream_tag: str | None,
    emit_model_token_sse: bool,
) -> list[str]:
    raw = data.get('chunk')
    if not isinstance(raw, AIMessageChunk):
        return []
    delta = aimessage_chunk_sse_delta(raw)
    if not is_meaningful_stream_delta(delta):
        return []
    state.stream_chunks += 1
    state.stream_chars += len(delta)
    if emit_model_token_sse:
        return [model_chunk_sse_line(delta, stream_tag)]
    return []


def _on_chat_model_end(
    data: dict[str, Any],
    state: GraphStreamState,
    *,
    agent_role: str | None,
    status_label: str,
    llm_event_prefix: str,
    llm_log_context: str,
    record_model_end_final_text: bool,
) -> list[str]:
    raw = data.get('output')
    msg = raw if isinstance(raw, AIMessage) else None
    if msg is None:
        return []
    lines = [
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
    ]
    log_llm_chat_response(
        msg,
        context=llm_log_context,
        agent_role=agent_role,
        llm_step=state.llm_step,
        stream_chunks=state.stream_chunks,
        stream_chars=state.stream_chars,
    )
    if not (msg.tool_calls or []):
        if record_model_end_final_text:
            state.last_final_text = final_assistant_text(msg)
    return lines


def _on_tool_start(
    ev: dict[str, Any],
    data: dict[str, Any],
    state: GraphStreamState,
    *,
    agent_role: str | None,
) -> list[str]:
    name = str(ev.get('name') or 'tool')
    raw_input = data.get('input')
    args: dict[str, Any] = raw_input if isinstance(raw_input, dict) else {}
    run_id = str(ev.get('run_id') or uuid.uuid4().hex[:12])
    state.pending_tool_runs[run_id] = (name, args)
    log_llm_tool_input(name, args, run_id=run_id, agent_role=agent_role)
    return [
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
    ]


def _on_tool_end(
    ev: dict[str, Any],
    data: dict[str, Any],
    state: GraphStreamState,
    *,
    agent_role: str | None,
) -> list[str]:
    name = str(ev.get('name') or 'tool')
    run_id = str(ev.get('run_id') or '')
    state.pending_tool_runs.pop(run_id, (name, {}))
    raw_out = data.get('output')
    result_text, ok, err_detail = _tool_output_text(raw_out)
    log_llm_tool_output(
        name,
        result_text,
        ok=ok,
        run_id=run_id or None,
        agent_role=agent_role,
        error_detail=err_detail,
    )
    lines: list[str] = list(iter_read_tool_stream_sse(name, result_text))
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


# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

def sse_lines_for_graph_event(
    ev: dict[str, Any],
    state: GraphStreamState,
    *,
    agent_role: str | None,
    status_label: str,
    llm_event_prefix: str,
    llm_log_context: str,
    stream_tag: str | None = None,
    emit_model_token_sse: bool = True,
    record_model_end_final_text: bool = True,
) -> list[str]:
    """Map one LangGraph v2 stream event to SSE JSON lines (side effect: updates ``state``).

    When ``emit_model_token_sse`` is False (nested planning/specialists), model token deltas are
    not sent to the client; status/tool events still are so the UI shows progress.

    When ``record_model_end_final_text`` is False, ``on_chat_model_end`` does not write
    ``state.last_final_text`` (parent-queue subgraph completions must not replace the outer agent outcome).
    """
    data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
    et = ev.get('event')

    if et == 'on_chat_model_start':
        return _on_chat_model_start(
            data, state,
            agent_role=agent_role,
            status_label=status_label,
            llm_event_prefix=llm_event_prefix,
            llm_log_context=llm_log_context,
        )
    if et == 'on_chat_model_stream':
        return _on_chat_model_stream(
            data, state,
            stream_tag=stream_tag,
            emit_model_token_sse=emit_model_token_sse,
        )
    if et == 'on_chat_model_end':
        return _on_chat_model_end(
            data, state,
            agent_role=agent_role,
            status_label=status_label,
            llm_event_prefix=llm_event_prefix,
            llm_log_context=llm_log_context,
            record_model_end_final_text=record_model_end_final_text,
        )
    if et == 'on_tool_start':
        return _on_tool_start(ev, data, state, agent_role=agent_role)
    if et == 'on_tool_end':
        return _on_tool_end(ev, data, state, agent_role=agent_role)
    return []


# ---------------------------------------------------------------------------
# Async queue racing
# ---------------------------------------------------------------------------

async def race_queues(*queues: asyncio.Queue, labels: tuple[str, ...]) -> tuple[str, Any]:
    """Wait for the first item from any queue; cancel losers.

    Returns ``(label, item)`` where ``label`` is the corresponding entry from *labels*.
    """
    tasks = [asyncio.create_task(q.get()) for q in queues]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
    finished = next(iter(done))
    for task, label in zip(tasks, labels):
        if task is finished:
            return label, finished.result()
    return labels[0], finished.result()
