"""Map LangGraph v2 stream events to SSE JSON lines and async queue racing helpers.

Extracted from :mod:`clara_coder_backend.lang_agent.graph` for readability and testability.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

from clara_coder_backend.lang_agent.streaming import (
    aimessage_chunk_reasoning_delta,
    aimessage_chunk_sse_delta,
    clear_primary_stream_sse_line,
    is_meaningful_stream_delta,
    iter_read_tool_stream_sse,
    model_chunk_sse_line,
    planner_progress_event,
    promote_primary_to_nudge_sse_line,
    sse_line,
    sse_tool_finished,
    status_event,
    tool_exec_chunk_event,
    tool_exec_complete_event,
    tool_running_detail,
)
from clara_coder_backend.logging.llm_interaction_logging import (
    coerce_messages_for_log,
    log_llm_chat_request_from_event_input,
    log_llm_chat_response,
)
from clara_coder_backend.llm.gemma_output import (
    GemmaStreamSplitter,
    extract_gemma_native_tool_calls,
    gemma_content_needs_parsing,
    strip_gemma_channel_markup,
)
from clara_coder_backend.llm.messages import final_assistant_text, reasoning_sidecar_text, stringify_content
from clara_coder_backend.llm.model_tuning import (
    gemma_enable_thinking_for_llm,
    gemma_output_parsing_active,
    outer_agent_brief_enabled,
)
from clara_coder_backend.session.state import get_active_connection
from clara_coder_backend.stream_tags import REASONING_AUXILIARY_STREAM_TAG
from clara_coder_backend.logging.tool_call_logging import log_llm_tool_input, log_llm_tool_output


@dataclass
class GraphStreamState:
    """Mutable per-stream counters for SSE event mapping."""

    pending_tool_runs: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    seen_tool_events: set[tuple[str, str, str]] = field(default_factory=set)
    last_final_text: str = ''
    partial_stream_text: str = ''
    #: Main agent text emitted live this LLM step (cleared from the UI when the step requests tools).
    deferred_agent_text: str = ''
    llm_step: int = 0
    stream_chunks: int = 0
    stream_chars: int = 0
    #: True once a ``stream_tag=reasoning`` chunk was emitted for the current LLM step.
    reasoning_emitted_this_step: bool = False
    gemma_split_for_step: bool = False
    gemma_splitter: GemmaStreamSplitter = field(default_factory=GemmaStreamSplitter)
    #: Next chat-model start follows a tool result; GGUF template may open thought in the prompt.
    gemma_resume_in_thought: bool = False
    #: True between ``on_chat_model_start`` and ``on_chat_model_end`` for the current LLM call.
    gemma_step_started: bool = False
    #: Native tool-call rows shown while write arguments are still streaming.
    gemma_native_previews: list[dict[str, Any]] = field(default_factory=list)
    gemma_run_id_alias: dict[str, str] = field(default_factory=dict)
    gemma_preview_seq: int = 0


def _token_usage_payload(msg: AIMessage) -> dict[str, Any] | None:
    """Build SSE ``token_usage`` body from LangChain :attr:`~langchain_core.messages.AIMessage.usage_metadata`.

    Populated when the chat model uses the OpenAI-compatible API with streaming usage enabled
    (see :func:`clara_coder_backend.llm.factory.build_llm`).
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
    # LangGraph ``astream_events`` v2 also emits nested ``on_chat_model_start`` for
    # ChatOpenAI under the agent wrapper. A second start must not rebuild the splitter
    # (that dropped post-tool ``start_in_channel``) or emit a duplicate Thinking row.
    if state.gemma_step_started:
        log_llm_chat_request_from_event_input(
            data.get('input'),
            context=llm_log_context,
            agent_role=agent_role,
            llm_step=state.llm_step,
        )
        return []
    leftover = (
        finalize_unconsumed_gemma_previews(
            state, agent_role=agent_role, stream_tag=stream_tag
        )
        if state.llm_step > 0
        else []
    )
    state.gemma_step_started = True
    state.llm_step += 1
    state.stream_chunks = 0
    state.stream_chars = 0
    state.deferred_agent_text = ''
    state.reasoning_emitted_this_step = False
    state.gemma_split_for_step = False
    resume_thought = _gemma_resume_in_thought_channel(data, state)
    state.gemma_splitter = GemmaStreamSplitter(start_in_channel=resume_thought)
    log_llm_chat_request_from_event_input(
        data.get('input'),
        context=llm_log_context,
        agent_role=agent_role,
        llm_step=state.llm_step,
    )
    return leftover + [
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


def _clara_outer_brief_enabled() -> bool:
    """True when first-turn primary prose should be retagged as a Clara brief."""
    try:
        return outer_agent_brief_enabled(get_active_connection())
    except Exception:
        return True


def _messages_resume_in_gemma_thought(raw_input: Any) -> bool:
    """True when this prompt already includes a tool result in the current user turn.

    After a tool response the GGUF template opens ``<|channel>thought`` in the prompt,
    so the completion has no matching open tag.
    """
    msgs = coerce_messages_for_log(raw_input)
    if not msgs:
        return False
    last_human = -1
    for i, msg in enumerate(msgs):
        if isinstance(msg, HumanMessage):
            last_human = i
    tail = msgs[last_human + 1 :] if last_human >= 0 else msgs
    return any(isinstance(msg, ToolMessage) for msg in tail)


def _gemma_resume_in_thought_channel(data: dict[str, Any], state: GraphStreamState) -> bool:
    """True when this LLM step should treat untagged leading tokens as thought.

    ``gemma_resume_in_thought`` is consumed here. Graph-injected ``HumanMessage``
    steps (flush leftover drafts, empty/pseudo-tool nudges) must not inherit
    post-tool thought mode from a prior tool result.
    """
    if not _gemma_thinking_opens_post_tool_channel():
        state.gemma_resume_in_thought = False
        return False
    sticky = state.gemma_resume_in_thought
    state.gemma_resume_in_thought = False
    msgs = coerce_messages_for_log(data.get('input'))
    if msgs:
        return _messages_resume_in_gemma_thought(data.get('input'))
    return sticky


def _gemma_thinking_opens_post_tool_channel() -> bool:
    """True when the GGUF template will open ``<|channel>thought`` after a tool response.

    The Jinja default is ``enable_thinking=true``. Settings ``thinking_mode=default`` omits
    the kwarg, so ``None`` still opens thought. Only explicit ``off`` skips it.
    """
    try:
        connection = get_active_connection()
        if not gemma_output_parsing_active(connection):
            return False
        return gemma_enable_thinking_for_llm(connection) is not False
    except Exception:
        return False


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


def _emit_gemma_native_tool_previews(
    state: GraphStreamState,
    *,
    agent_role: str | None,
    stream_tag: str | None,
) -> list[str]:
    """Turn splitter peeks into live tool-trail rows (same id later reused at on_tool_start)."""
    lines: list[str] = []
    for peek in state.gemma_splitter.drain_tool_peeks():
        name = str(peek.get('name') or '').strip()
        if not name:
            continue
        args = peek.get('args') if isinstance(peek.get('args'), dict) else {}
        if peek.get('cancelled'):
            lines.extend(
                _finalize_gemma_preview_named(
                    state, name=name, agent_role=agent_role, stream_tag=stream_tag
                )
            )
            continue
        if peek.get('update'):
            target = _find_gemma_preview(state, name=name, args=args, prefer_recent=True)
            if target is not None:
                lines.append(
                    sse_line(
                        status_event(
                            str(target['id']),
                            name,
                            detail=tool_running_detail(name, args),
                            state='running',
                            source='tool',
                            agent_role=agent_role,
                            stream_tag=stream_tag,
                        )
                    )
                )
                target['args'] = args
            continue
        state.gemma_preview_seq += 1
        preview_id = f'gemma-tool-preview-{state.gemma_preview_seq}'
        state.gemma_native_previews.append(
            {'id': preview_id, 'name': name, 'args': args, 'consumed': False}
        )
        state.pending_tool_runs[preview_id] = (name, args)
        lines.append(
            sse_line(
                status_event(
                    preview_id,
                    name,
                    detail=tool_running_detail(name, args),
                    state='running',
                    source='tool',
                    agent_role=agent_role,
                    stream_tag=stream_tag,
                )
            )
        )
    return lines


def _gemma_preview_complete_line(
    item: dict[str, Any],
    *,
    agent_role: str | None,
    stream_tag: str | None,
) -> str:
    name = str(item.get('name') or 'tool')
    args = item.get('args') if isinstance(item.get('args'), dict) else {}
    return sse_line(
        status_event(
            str(item['id']),
            name,
            detail=tool_running_detail(name, args),
            state='complete',
            source='tool',
            agent_role=agent_role,
            stream_tag=stream_tag,
        )
    )


def _preview_path_value(args: dict[str, Any]) -> str:
    """Path fingerprint across Gemma aliases (``path`` / ``relative_path`` / ``file_path``)."""
    for key in ('relative_path', 'path', 'file_path'):
        raw = args.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip().replace('\\', '/')
    return ''


def _find_gemma_preview(
    state: GraphStreamState,
    *,
    name: str,
    args: dict[str, Any] | None = None,
    prefer_recent: bool = False,
) -> dict[str, Any] | None:
    """Return the unconsumed preview for ``name``, preferring a matching path fingerprint."""
    items = list(state.gemma_native_previews)
    if prefer_recent:
        items = list(reversed(items))
    wanted = _preview_path_value(args if isinstance(args, dict) else {})
    if wanted:
        for item in items:
            if item.get('consumed') or item.get('name') != name:
                continue
            item_args = item.get('args') if isinstance(item.get('args'), dict) else {}
            if _preview_path_value(item_args) == wanted:
                return item
    for item in items:
        if item.get('consumed') or item.get('name') != name:
            continue
        return item
    return None


def _finalize_gemma_preview_named(
    state: GraphStreamState,
    *,
    name: str,
    agent_role: str | None,
    stream_tag: str | None,
) -> list[str]:
    item = _find_gemma_preview(state, name=name, prefer_recent=True)
    if item is None:
        return []
    item['consumed'] = True
    preview_id = str(item['id'])
    state.pending_tool_runs.pop(preview_id, None)
    return [_gemma_preview_complete_line(item, agent_role=agent_role, stream_tag=stream_tag)]


def finalize_unconsumed_gemma_previews(
    state: GraphStreamState,
    *,
    agent_role: str | None,
    stream_tag: str | None,
) -> list[str]:
    """Complete leftover native-tool peeks so the UI does not stay on running."""
    lines: list[str] = []
    for item in state.gemma_native_previews:
        if item.get('consumed'):
            continue
        item['consumed'] = True
        preview_id = str(item['id'])
        state.pending_tool_runs.pop(preview_id, None)
        lines.append(_gemma_preview_complete_line(item, agent_role=agent_role, stream_tag=stream_tag))
    return lines


def _bind_gemma_tool_preview(
    state: GraphStreamState,
    *,
    name: str,
    run_id: str,
    args: dict[str, Any] | None = None,
) -> str:
    """Reuse a streaming preview row so on_tool_start does not add a second pill.

    Parallel same-name tools bind FIFO by path fingerprint, then by the oldest
    unconsumed peek that still lacks a path.
    """
    item = _find_gemma_preview(state, name=name, args=args)
    if item is None:
        return run_id
    item['consumed'] = True
    item['run_id'] = run_id
    preview_id = str(item['id'])
    state.pending_tool_runs.pop(preview_id, None)
    state.gemma_run_id_alias[run_id] = preview_id
    return preview_id


def _status_id_for_tool_run(state: GraphStreamState, run_id: str) -> str:
    return state.gemma_run_id_alias.get(run_id, run_id)


def _on_chat_model_stream(
    data: dict[str, Any],
    state: GraphStreamState,
    *,
    stream_tag: str | None,
    emit_model_token_sse: bool,
    agent_role: str | None = None,
) -> list[str]:
    raw = data.get('chunk')
    if not isinstance(raw, AIMessageChunk):
        return []
    delta = aimessage_chunk_sse_delta(raw)
    reason_delta = aimessage_chunk_reasoning_delta(raw)
    if delta and _gemma_stream_split_enabled(state, delta):
        main_delta, split_reason = state.gemma_splitter.feed(delta)
        delta = main_delta
        if split_reason:
            reason_delta = f'{reason_delta}{split_reason}'
    preview_lines = _emit_gemma_native_tool_previews(
        state, agent_role=agent_role, stream_tag=stream_tag
    )
    if reason_delta and (
        state.gemma_split_for_step
        or gemma_content_needs_parsing(reason_delta)
    ):
        reason_delta = strip_gemma_channel_markup(reason_delta)
    main_ok = is_meaningful_stream_delta(delta)
    reasoning_ok = is_meaningful_stream_delta(reason_delta)
    if not main_ok and not reasoning_ok:
        return preview_lines
    state.stream_chunks += 1
    if main_ok:
        state.stream_chars += len(delta)
    if reasoning_ok:
        state.stream_chars += len(reason_delta)
    if emit_model_token_sse and main_ok:
        state.partial_stream_text += delta
        state.deferred_agent_text += delta
    if not emit_model_token_sse:
        return preview_lines
    out: list[str] = list(preview_lines)
    if main_ok:
        # Stream primary live; tool steps clear it at ``on_chat_model_end``.
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
    state.gemma_step_started = False
    if msg is None:
        return []
    lines: list[str] = []
    if state.gemma_split_for_step:
        flush_main, flush_reason = state.gemma_splitter.flush()
        lines.extend(
            _emit_gemma_native_tool_previews(
                state, agent_role=agent_role, stream_tag=stream_tag
            )
        )
        if emit_model_token_sse:
            if is_meaningful_stream_delta(flush_main):
                state.partial_stream_text += flush_main
                state.deferred_agent_text += flush_main
                lines.append(model_chunk_sse_line(flush_main, stream_tag))
            if is_meaningful_stream_delta(flush_reason):
                lines.append(model_chunk_sse_line(flush_reason, REASONING_AUXILIARY_STREAM_TAG))
                state.reasoning_emitted_this_step = True
    if emit_model_token_sse and not state.reasoning_emitted_this_step:
        side = reasoning_sidecar_text(msg)
        if side and is_meaningful_stream_delta(side):
            lines.append(model_chunk_sse_line(side, REASONING_AUXILIARY_STREAM_TAG))
            state.reasoning_emitted_this_step = True
    has_tool_calls = bool(msg.tool_calls or [])
    if not has_tool_calls:
        for text in (stringify_content(msg.content), reasoning_sidecar_text(msg)):
            if text and extract_gemma_native_tool_calls(text):
                has_tool_calls = True
                break
    if not has_tool_calls:
        lines.extend(
            finalize_unconsumed_gemma_previews(
                state, agent_role=agent_role, stream_tag=stream_tag
            )
        )
    if emit_model_token_sse:
        if has_tool_calls:
            if (
                state.deferred_agent_text
                and is_meaningful_stream_delta(state.deferred_agent_text)
                and _clara_outer_brief_enabled()
            ):
                lines.append(clear_primary_stream_sse_line())
            state.deferred_agent_text = ''
        else:
            # Primary was already streamed live; do not re-dump at end.
            state.deferred_agent_text = ''
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
    if not has_tool_calls:
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
    status_id = _bind_gemma_tool_preview(state, name=name, run_id=run_id, args=args)
    return [
        sse_line(
            status_event(
                status_id,
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
    state.gemma_resume_in_thought = True
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
            _status_id_for_tool_run(state, run_id) or name,
            name,
            result_text,
            ok=ok,
            error_detail=err_detail,
            agent_role=agent_role,
            stream_tag=stream_tag,
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
            agent_role=agent_role,
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
    if et == 'agent_nudge' or (et == 'on_custom_event' and ev.get('name') == 'agent_nudge'):
        state.last_final_text = ''
        state.deferred_agent_text = ''
        return [promote_primary_to_nudge_sse_line()]
    if et == 'outer_agent_brief':
        if not _clara_outer_brief_enabled():
            return []
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
        from clara_coder_backend.lang_agent.streaming import background_command_open_event

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
        from clara_coder_backend.lang_agent.streaming import planner_progress_event

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
