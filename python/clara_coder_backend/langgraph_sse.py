"""Map LangGraph v2 stream events to SSE JSON lines and async queue racing helpers.

Extracted from :mod:`clara_coder_backend.agent_langgraph` for readability and testability.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from clara_coder_backend.agent_streaming import (
    aimessage_chunk_reasoning_delta,
    aimessage_chunk_sse_delta,
    is_meaningful_stream_delta,
    iter_read_tool_stream_sse,
    model_chunk_sse_line,
    planner_progress_event,
    sse_line,
    sse_tool_finished,
    status_event,
    tool_exec_chunk_event,
    tool_exec_complete_event,
    tool_running_detail,
)
from clara_coder_backend.llm_interaction_logging import (
    log_llm_chat_request_from_event_input,
    log_llm_chat_response,
)
from clara_coder_backend.gemma_output import GemmaStreamSplitter, gemma_content_needs_parsing
from clara_coder_backend.messages import final_assistant_text, reasoning_sidecar_text, stringify_content
from clara_coder_backend.model_tuning import gemma_output_parsing_active
from clara_coder_backend.state import get_active_connection
from clara_coder_backend.stream_tags import REASONING_AUXILIARY_STREAM_TAG
from clara_coder_backend.tool_call_logging import log_llm_tool_input, log_llm_tool_output
from clara_coder_backend.tool_harness_feedback_middleware import pending_harness_crystal_polarity


@dataclass
class GraphStreamState:
    """Mutable per-stream counters for SSE event mapping."""

    pending_tool_runs: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    seen_tool_events: set[tuple[str, str, str]] = field(default_factory=set)
    last_final_text: str = ''
    partial_stream_text: str = ''
    llm_step: int = 0
    stream_chunks: int = 0
    stream_chars: int = 0
    #: True once a ``stream_tag=reasoning`` chunk was emitted for the current LLM step.
    reasoning_emitted_this_step: bool = False
    gemma_split_for_step: bool = False
    gemma_splitter: GemmaStreamSplitter = field(default_factory=GemmaStreamSplitter)


def _token_usage_payload(msg: AIMessage) -> dict[str, Any] | None:
    """Build SSE ``token_usage`` body from LangChain :attr:`~langchain_core.messages.AIMessage.usage_metadata`.

    Populated when the chat model uses the OpenAI-compatible API with streaming usage enabled
    (see :func:`clara_coder_backend.llm.build_llm`).
    """
    raw = getattr(msg, 'usage_metadata', None)
    if raw is None:
        return None
    inp: Any
    out: Any
    tot: Any
    if isinstance(raw, dict):
        inp = raw.get('input_tokens')
        out = raw.get('output_tokens')
        tot = raw.get('total_tokens')
    else:
        inp = getattr(raw, 'input_tokens', None)
        out = getattr(raw, 'output_tokens', None)
        tot = getattr(raw, 'total_tokens', None)
    body: dict[str, Any] = {'type': 'token_usage'}
    if isinstance(inp, int):
        body['input_tokens'] = inp
    if isinstance(out, int):
        body['output_tokens'] = out
    if isinstance(tot, int):
        body['total_tokens'] = tot
    return body if len(body) > 1 else None


def _loggable_tool_result_text(_name: str, result_text: str) -> str:
    return result_text


def _tool_event_seen(state: GraphStreamState, *, phase: str, name: str, run_id: str) -> bool:
    if not run_id:
        return False
    key = (phase, name, run_id)
    if key in state.seen_tool_events:
        return True
    state.seen_tool_events.add(key)
    return False


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
    stream_tag: str | None,
    status_label: str,
    llm_event_prefix: str,
    llm_log_context: str,
) -> list[str]:
    state.llm_step += 1
    state.stream_chunks = 0
    state.stream_chars = 0
    state.reasoning_emitted_this_step = False
    state.gemma_split_for_step = False
    state.gemma_splitter = GemmaStreamSplitter()
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
                stream_tag=stream_tag,
            )
        )
    ]


def _gemma_stream_split_enabled(state: GraphStreamState, delta: str) -> bool:
    if state.gemma_split_for_step:
        return True
    try:
        if gemma_output_parsing_active(get_active_connection()):
            state.gemma_split_for_step = True
            return True
    except Exception:
        pass
    if gemma_content_needs_parsing(delta):
        state.gemma_split_for_step = True
        return True
    return False


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
    reason_delta = aimessage_chunk_reasoning_delta(raw)
    if not reason_delta.strip() and delta and _gemma_stream_split_enabled(state, delta):
        main_delta, split_reason = state.gemma_splitter.feed(delta)
        delta = main_delta
        if split_reason:
            reason_delta = f'{reason_delta}{split_reason}'
    main_ok = is_meaningful_stream_delta(delta)
    reasoning_ok = is_meaningful_stream_delta(reason_delta)
    if not main_ok and not reasoning_ok:
        return []
    if main_ok:
        state.stream_chunks += 1
        state.stream_chars += len(delta)
    if emit_model_token_sse and main_ok:
        state.partial_stream_text += delta
    if not emit_model_token_sse:
        return []
    out: list[str] = []
    if main_ok:
        out.append(model_chunk_sse_line(delta, stream_tag))
    if reasoning_ok:
        out.append(model_chunk_sse_line(reason_delta, REASONING_AUXILIARY_STREAM_TAG))
        state.reasoning_emitted_this_step = True
    return out


def _on_chat_model_end(
    data: dict[str, Any],
    state: GraphStreamState,
    *,
    agent_role: str | None,
    stream_tag: str | None,
    status_label: str,
    llm_event_prefix: str,
    llm_log_context: str,
    record_model_end_final_text: bool,
    emit_model_token_sse: bool,
) -> list[str]:
    raw = data.get('output')
    msg = raw if isinstance(raw, AIMessage) else None
    if msg is None:
        return []
    lines: list[str] = []
    if state.gemma_split_for_step:
        flush_main, flush_reason = state.gemma_splitter.flush()
        if emit_model_token_sse:
            if is_meaningful_stream_delta(flush_main):
                lines.append(model_chunk_sse_line(flush_main, stream_tag))
            if is_meaningful_stream_delta(flush_reason):
                lines.append(model_chunk_sse_line(flush_reason, REASONING_AUXILIARY_STREAM_TAG))
                state.reasoning_emitted_this_step = True
    if emit_model_token_sse and not state.reasoning_emitted_this_step:
        side = reasoning_sidecar_text(msg)
        if side and is_meaningful_stream_delta(side):
            lines.append(model_chunk_sse_line(side, REASONING_AUXILIARY_STREAM_TAG))
            state.reasoning_emitted_this_step = True
    lines.append(
        sse_line(
            status_event(
                f'{llm_event_prefix}-{state.llm_step}',
                status_label,
                detail='',
                state='complete',
                source='agent',
                agent_role=agent_role,
                stream_tag=stream_tag,
            )
        )
    )
    log_llm_chat_response(
        msg,
        context=llm_log_context,
        agent_role=agent_role,
        llm_step=state.llm_step,
        stream_chunks=state.stream_chunks,
        stream_chars=state.stream_chars,
    )
    usage_payload = _token_usage_payload(msg)
    if usage_payload is not None:
        lines.insert(0, sse_line(usage_payload))
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
    stream_tag: str | None,
) -> list[str]:
    name = str(ev.get('name') or 'tool')
    raw_input = data.get('input')
    args: dict[str, Any] = raw_input if isinstance(raw_input, dict) else {}
    run_id = str(ev.get('run_id') or uuid.uuid4().hex[:12])
    if _tool_event_seen(state, phase='start', name=name, run_id=run_id):
        return []
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
                stream_tag=stream_tag,
            )
        )
    ]


def _on_tool_end(
    ev: dict[str, Any],
    data: dict[str, Any],
    state: GraphStreamState,
    *,
    agent_role: str | None,
    stream_tag: str | None,
) -> list[str]:
    name = str(ev.get('name') or 'tool')
    run_id = str(ev.get('run_id') or '')
    if _tool_event_seen(state, phase='end', name=name, run_id=run_id):
        return []
    state.pending_tool_runs.pop(run_id, (name, {}))
    raw_out = data.get('output')
    result_text, ok, err_detail = _tool_output_text(raw_out)
    log_llm_tool_output(
        name,
        _loggable_tool_result_text(name, result_text),
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
            stream_tag=stream_tag,
        )
    )
    crystal_pol = pending_harness_crystal_polarity.get()
    if crystal_pol is not None:
        pending_harness_crystal_polarity.set(None)
        lines.append(sse_line({'type': 'harness_crystal', 'polarity': crystal_pol}))
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
            stream_tag=stream_tag,
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
            stream_tag=stream_tag,
            status_label=status_label,
            llm_event_prefix=llm_event_prefix,
            llm_log_context=llm_log_context,
            record_model_end_final_text=record_model_end_final_text,
            emit_model_token_sse=emit_model_token_sse,
        )
    if et == 'on_tool_start':
        return _on_tool_start(ev, data, state, agent_role=agent_role, stream_tag=stream_tag)
    if et == 'on_tool_end':
        return _on_tool_end(ev, data, state, agent_role=agent_role, stream_tag=stream_tag)
    if et == 'outer_agent_brief':
        summary = data.get('summary')
        label = data.get('label')
        if not isinstance(summary, str) or not summary.strip():
            return []
        detail = summary.strip()
        lbl = label if isinstance(label, str) and label.strip() else 'Clara'
        return [
            sse_line(
                status_event(
                    f'outer-brief-{uuid.uuid4().hex[:12]}',
                    lbl,
                    detail=detail,
                    state='complete',
                    source='agent',
                    stream_tag='clara',
                ),
            ),
        ]
    if et == 'background_command_open':
        command_id = data.get('command_id')
        command_text = data.get('command_text')
        cwd_label = data.get('cwd_label')
        label_value = data.get('label')
        stream_tag_value = data.get('stream_tag')
        if not isinstance(command_id, str) or not command_id.strip():
            return []
        if not isinstance(command_text, str):
            return []
        if not isinstance(cwd_label, str):
            return []
        label_out = label_value if isinstance(label_value, str) and label_value.strip() else ''
        stream_tag_out = (
            stream_tag_value if isinstance(stream_tag_value, str) and stream_tag_value.strip() else stream_tag
        )
        from clara_coder_backend.agent_streaming import background_command_open_event

        return [
            sse_line(
                background_command_open_event(
                    command_id=command_id.strip(),
                    command_text=command_text,
                    cwd_label=cwd_label,
                    label=label_out,
                    stream_tag=stream_tag_out,
                ),
            ),
        ]
    if et == 'tool_exec_chunk':
        delta = data.get('delta')
        if not isinstance(delta, str) or not delta:
            return []
        stream_tag_value = data.get('stream_tag')
        label_value = data.get('label')
        stream_tag_out = stream_tag_value if isinstance(stream_tag_value, str) and stream_tag_value.strip() else stream_tag
        label_out = label_value if isinstance(label_value, str) else ''
        return [sse_line(tool_exec_chunk_event(delta, stream_tag=stream_tag_out, label=label_out))]
    if et == 'tool_exec_complete':
        stream_tag_value = data.get('stream_tag')
        label_value = data.get('label')
        exit_raw = data.get('exit_code')
        stream_tag_out = stream_tag_value if isinstance(stream_tag_value, str) and stream_tag_value.strip() else stream_tag
        label_out = label_value if isinstance(label_value, str) else ''
        exit_code: int | None
        if isinstance(exit_raw, int):
            exit_code = exit_raw
        elif exit_raw is None:
            exit_code = None
        else:
            exit_code = None
        excerpt_raw = data.get('output_excerpt')
        output_excerpt = excerpt_raw.strip() if isinstance(excerpt_raw, str) else ''
        outcome_raw = data.get('outcome')
        outcome = outcome_raw if outcome_raw in ('passed', 'failed') else None
        return [
            sse_line(
                tool_exec_complete_event(
                    stream_tag=stream_tag_out,
                    label=label_out,
                    exit_code=exit_code,
                    output_excerpt=output_excerpt,
                    outcome=outcome,
                ),
            ),
        ]
    if et == 'planner_progress':
        from clara_coder_backend.agent_streaming import planner_progress_event

        planner_data = data.get('planner')
        if isinstance(planner_data, dict):
            return [sse_line(planner_progress_event(planner_data))]
        return []
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
