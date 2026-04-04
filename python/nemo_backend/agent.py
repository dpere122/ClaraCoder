"""SSE streaming agent: LangChain tool loop (classic) with optional LangGraph paths (single, manager, worker).

Yields Server-Sent Events lines consumed by the Electron renderer. Status events report
tool progress and optional ``agent_role`` (``manager`` | ``worker``) for UI labels.

When :attr:`~nemo_backend.domain.SessionState.auto_apply_mode` is false and a tool in
:func:`nemo_backend.tool_registry.hitl_diff_pause_tools` emits a diff, the HTTP stream
pauses until ``POST /chat/agent-continue``. The classic loop uses :func:`_await_diff_review_pause`;
LangGraph agents use :mod:`nemo_backend.diff_review_middleware` and the same pause API.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    BaseMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    message_chunk_to_message,
)

from nemo_backend.agent_langgraph import (
    LangGraphWorkerOutcome,
    stream_manager_langgraph,
    stream_single_agent_langgraph,
    stream_worker_langgraph,
)
from nemo_backend.agent_pause import await_diff_review_note
from nemo_backend.agent_streaming import (
    aimessage_chunk_sse_delta,
    is_meaningful_stream_delta,
    iter_read_tool_stream_sse,
    sse_line,
    sse_tool_finished,
    status_event,
    tool_running_detail,
)
from nemo_backend.config import (
    MAX_AGENT_EMPTY_NUDGES,
    MAX_AGENT_LENGTH_CONTINUES,
    MAX_AGENT_STEPS,
    MAX_AGENT_TOOL_FORMAT_NUDGES,
    MAX_TOOL_STATUS_LINE,
    NEMO_MANAGER_WORKER,
    NEMO_USE_LANGGRAPH_AGENT,
    NEMO_WORKER_RESULT_MAX_CHARS,
)
from nemo_backend.llm import build_llm
from nemo_backend.model_tuning import effective_parallel_tool_calls
from nemo_backend.messages import (
    build_manager_system_prompt,
    build_system_prompt,
    build_worker_system_prompt,
    final_assistant_text,
    session_to_messages,
    stringify_content,
    text_uses_pseudo_tool_markup,
)
from nemo_backend.manager_tools import DELEGATE_WORKSPACE_TASK_NAME
from nemo_backend.state import current_session_id, get_active_connection, get_session
from nemo_backend.tool_registry import hitl_diff_pause_tools, manager_tools_and_map, worker_tools_and_map
from nemo_backend.workspace_tools import truncate_text

logger = logging.getLogger('nemo.agent')


@dataclass
class ToolLoopOutcome:
    final_text: str = ''


def _truncate_for_manager(text: str) -> str:
    if len(text) <= NEMO_WORKER_RESULT_MAX_CHARS:
        return text
    return (
        text[:NEMO_WORKER_RESULT_MAX_CHARS]
        + '\n\n[Worker output truncated for manager context; increase NEMO_WORKER_RESULT_MAX_CHARS if needed.]'
    )


async def _await_diff_review_pause(session_id: str, working_messages: list[BaseMessage]) -> None:
    note = await await_diff_review_note(session_id)
    if note:
        working_messages.append(HumanMessage(content=note))


async def invoke_tool(tool_name: str, args: dict[str, Any], tool_map: dict[str, Any]) -> str:
    tool_ = tool_map.get(tool_name)
    if tool_ is None:
        raise ValueError(f'Unknown tool: {tool_name}')
    result = await tool_.ainvoke(args)
    return stringify_content(result)


async def stream_classic_tool_loop(
    working_messages: list[BaseMessage],
    llm: Any,
    tool_map: dict[str, Any],
    session_id: str,
    apply_mode: bool,
    *,
    outcome: ToolLoopOutcome,
    agent_role: str | None = None,
    thinking_prefix: str = 'step',
    delegate_runner: Callable[[dict[str, Any], str], AsyncIterator[str]] | None = None,
    delegate_outcome: ToolLoopOutcome | None = None,
) -> AsyncIterator[str]:
    """Run the classic bind_tools loop with ``astream`` per turn; optionally handle delegation from the manager."""
    finished_after_tool_phase = False
    reply_prefix_parts: list[str] = []
    length_continues = 0
    empty_final_nudges = 0
    tool_format_nudges = 0
    final_text = ''
    label = 'Manager' if agent_role == 'manager' else 'Worker' if agent_role == 'worker' else 'Agent'

    for step in range(1, MAX_AGENT_STEPS + 1):
        if agent_role:
            yield sse_line(
                status_event(
                    f'{thinking_prefix}-{step}',
                    label,
                    detail='Thinking…',
                    state='running',
                    source='agent',
                    agent_role=agent_role,
                )
            )

        accumulated: BaseMessageChunk | None = None
        async for raw_chunk in llm.astream(working_messages):
            if not isinstance(raw_chunk, BaseMessageChunk):
                continue
            accumulated = raw_chunk if accumulated is None else accumulated + raw_chunk
            if isinstance(raw_chunk, AIMessageChunk):
                delta = aimessage_chunk_sse_delta(raw_chunk)
                if is_meaningful_stream_delta(delta):
                    yield sse_line({'type': 'chunk', 'delta': delta})

        if accumulated is None:
            ai_message = AIMessage(content='')
        else:
            merged = message_chunk_to_message(accumulated)
            ai_message = merged if isinstance(merged, AIMessage) else AIMessage(content=stringify_content(merged.content))

        working_messages.append(ai_message)

        if agent_role:
            yield sse_line(
                status_event(
                    f'{thinking_prefix}-{step}',
                    label,
                    detail='',
                    state='complete',
                    source='agent',
                    agent_role=agent_role,
                )
            )

        if ai_message.tool_calls:
            for index, tool_call in enumerate(ai_message.tool_calls, start=1):
                tool_name = tool_call.get('name', 'tool')
                tool_args = tool_call.get('args', {}) if isinstance(tool_call.get('args'), dict) else {}
                tool_id = tool_call.get('id') or f'{step}-{index}'

                if (
                    delegate_runner is not None
                    and delegate_outcome is not None
                    and tool_name == DELEGATE_WORKSPACE_TASK_NAME
                ):
                    yield sse_line(
                        status_event(
                            tool_id,
                            tool_name,
                            detail=truncate_text(
                                (tool_args.get('task_summary') or '').replace('\n', ' ').strip(),
                                MAX_TOOL_STATUS_LINE,
                            ),
                            state='running',
                            source='tool',
                            agent_role='manager',
                        )
                    )
                    try:
                        delegate_outcome.final_text = ''
                        async for line in delegate_runner(tool_args, tool_id):
                            yield line
                        tool_result = _truncate_for_manager(delegate_outcome.final_text)
                        working_messages.append(ToolMessage(content=tool_result, tool_call_id=tool_id))
                        yield sse_tool_finished(
                            tool_id,
                            tool_name,
                            tool_result,
                            ok=True,
                            agent_role='manager',
                        )
                    except Exception as exc:
                        error_text = f'{type(exc).__name__}: {exc}'
                        get_session(session_id).pending_diff_payload = None
                        working_messages.append(
                            ToolMessage(content=f'Tool error: {error_text}', tool_call_id=tool_id)
                        )
                        yield sse_tool_finished(
                            tool_id,
                            tool_name,
                            '',
                            ok=False,
                            error_detail=error_text,
                            agent_role='manager',
                        )
                    continue

                yield sse_line(
                    status_event(
                        tool_id,
                        tool_name,
                        detail=tool_running_detail(tool_name, tool_args),
                        state='running',
                        source='tool',
                        agent_role=agent_role,
                    )
                )
                try:
                    tool_result = await invoke_tool(tool_name, tool_args, tool_map)
                    working_messages.append(ToolMessage(content=tool_result, tool_call_id=tool_id))
                    for stream_line in iter_read_tool_stream_sse(tool_name, tool_result):
                        yield stream_line
                    diff_emitted = False
                    if tool_name in hitl_diff_pause_tools() and apply_mode:
                        sess = get_session(session_id)
                        pending = sess.pending_diff_payload
                        if pending:
                            yield sse_line({'type': 'diff', 'diff': pending})
                            sess.pending_diff_payload = None
                            diff_emitted = True
                    yield sse_tool_finished(
                        tool_id,
                        tool_name,
                        tool_result,
                        ok=True,
                        agent_role=agent_role,
                    )
                    if diff_emitted and not get_session(session_id).auto_apply_mode:
                        await _await_diff_review_pause(session_id, working_messages)
                except Exception as exc:
                    error_text = f'{type(exc).__name__}: {exc}'
                    get_session(session_id).pending_diff_payload = None
                    working_messages.append(
                        ToolMessage(content=f'Tool error: {error_text}', tool_call_id=tool_id)
                    )
                    yield sse_tool_finished(
                        tool_id,
                        tool_name,
                        '',
                        ok=False,
                        error_detail=error_text,
                        agent_role=agent_role,
                    )
            continue

        invalid_calls = list(getattr(ai_message, 'invalid_tool_calls', None) or ())
        if invalid_calls:
            lines: list[str] = []
            for inv in invalid_calls:
                name = inv.get('name') if isinstance(inv, dict) else getattr(inv, 'name', None)
                err = inv.get('error') if isinstance(inv, dict) else getattr(inv, 'error', None)
                lines.append(f'- {name or "tool"}: {err or "invalid arguments"}')
            working_messages.append(
                HumanMessage(
                    content=(
                        'Tool call(s) could not be executed (bad name or JSON arguments). '
                        'Fix the tool call or answer without tools.\n' + '\n'.join(lines)
                    )
                )
            )
            continue

        chunk = final_assistant_text(ai_message)
        meta = getattr(ai_message, 'response_metadata', None) or {}
        finish_reason = meta.get('finish_reason')

        if not chunk:
            if empty_final_nudges < MAX_AGENT_EMPTY_NUDGES:
                empty_final_nudges += 1
                logger.info(
                    'Nudging after empty no-tool turn (%s/%s LLM steps)',
                    empty_final_nudges,
                    MAX_AGENT_EMPTY_NUDGES,
                )
                working_messages.append(
                    HumanMessage(
                        content=(
                            'Your last message had no user-visible text. Reply with a clear, complete '
                            'answer for the user (plain language; omit tools if not needed).'
                        )
                    )
                )
                continue
            finished_after_tool_phase = True
            final_text = ''
            logger.warning(
                'Empty final assistant text after tool phase: content=%r additional_kwargs=%r '
                'response_metadata=%r tool_calls=%r',
                ai_message.content,
                getattr(ai_message, 'additional_kwargs', {}),
                meta,
                getattr(ai_message, 'tool_calls', None),
            )
            break

        if text_uses_pseudo_tool_markup(chunk) and tool_format_nudges < MAX_AGENT_TOOL_FORMAT_NUDGES:
            tool_format_nudges += 1
            logger.info(
                'Nudging: pseudo tool markup without tool_calls (%s/%s)',
                tool_format_nudges,
                MAX_AGENT_TOOL_FORMAT_NUDGES,
            )
            working_messages.append(
                HumanMessage(
                    content=(
                        'Your last turn included tool calls as plain text or XML, but the API '
                        'did not receive structured tool_calls. Invoke the next step using the '
                        'model’s native tool/function calling only (same tools as before).'
                    )
                )
            )
            continue

        if finish_reason == 'length' and length_continues < MAX_AGENT_LENGTH_CONTINUES:
            reply_prefix_parts.append(chunk)
            length_continues += 1
            logger.info(
                'Output limit hit (finish_reason=length); continuation %s/%s',
                length_continues,
                MAX_AGENT_LENGTH_CONTINUES,
            )
            working_messages.append(
                HumanMessage(
                    content=(
                        'Your answer was cut off by the output limit. Continue with only the '
                        'remainder—do not repeat text you already gave.'
                    )
                )
            )
            continue

        finished_after_tool_phase = True
        final_text = '\n\n'.join(reply_prefix_parts + [chunk]).strip()
        break

    if not final_text:
        if finished_after_tool_phase:
            final_text = (
                'The model stopped using tools but did not return any text for the final answer. '
                'Try the same request again, or ask for a shorter summary.'
            )
        else:
            final_text = (
                f'Reached the agent step limit ({MAX_AGENT_STEPS} LLM turns) before a final answer. '
                'Narrow the request, or set NEMO_MAX_AGENT_STEPS to raise the cap (max 5000).'
            )

    outcome.final_text = final_text


async def stream_agent_reply(
    session_id: str,
    user_message: str,
    apply_mode: bool = True,
    auto_apply_mode: bool = False,
) -> AsyncIterator[str]:
    """Run the tool-capable agent and yield SSE lines until [DONE]."""
    session = get_session(session_id)
    session.agent_pause_event = None
    session.agent_pause_note = None
    session.auto_apply_mode = auto_apply_mode
    active_conn = get_active_connection()
    parallel_tool_calls = effective_parallel_tool_calls(active_conn)

    token = current_session_id.set(session_id)

    try:
        try:
            llm_base = build_llm()
        except HTTPException as exc:
            yield sse_line(
                status_event(
                    'bootstrap',
                    'Configuration issue',
                    detail=truncate_text(str(exc.detail).replace('\n', ' '), MAX_TOOL_STATUS_LINE),
                    state='error',
                )
            )
            yield sse_line({'type': 'chunk', 'delta': exc.detail})
            yield 'data: [DONE]\n\n'
            return

        if not NEMO_MANAGER_WORKER:
            if NEMO_USE_LANGGRAPH_AGENT:
                graph_single = LangGraphWorkerOutcome()
                async for line in stream_single_agent_langgraph(
                    session,
                    user_message,
                    apply_mode,
                    session_id=session_id,
                    outcome=graph_single,
                ):
                    yield line
                final_text = graph_single.final_text
            else:
                tools, tool_map = worker_tools_and_map(apply_mode)
                try:
                    llm = llm_base.bind_tools(tools, parallel_tool_calls=parallel_tool_calls)
                except HTTPException as exc:
                    yield sse_line(
                        status_event(
                            'bootstrap',
                            'Configuration issue',
                            detail=truncate_text(str(exc.detail).replace('\n', ' '), MAX_TOOL_STATUS_LINE),
                            state='error',
                        )
                    )
                    yield sse_line({'type': 'chunk', 'delta': exc.detail})
                    yield 'data: [DONE]\n\n'
                    return

                working_messages: list[BaseMessage] = [
                    SystemMessage(content=build_system_prompt(session, apply_mode)),
                    *session_to_messages(session),
                    HumanMessage(content=user_message),
                ]
                outcome = ToolLoopOutcome()
                async for line in stream_classic_tool_loop(
                    working_messages,
                    llm,
                    tool_map,
                    session_id,
                    apply_mode,
                    outcome=outcome,
                    agent_role=None,
                ):
                    yield line
                final_text = outcome.final_text
        else:
            if NEMO_USE_LANGGRAPH_AGENT:
                graph_mgr = LangGraphWorkerOutcome()
                async for line in stream_manager_langgraph(
                    session,
                    user_message,
                    apply_mode,
                    session_id=session_id,
                    outcome=graph_mgr,
                ):
                    yield line
                final_text = graph_mgr.final_text
            else:
                mgr_tools, mgr_map = manager_tools_and_map(apply_mode)
                try:
                    llm_mgr = llm_base.bind_tools(mgr_tools, parallel_tool_calls=parallel_tool_calls)
                except HTTPException as exc:
                    yield sse_line(
                        status_event(
                            'bootstrap',
                            'Configuration issue',
                            detail=truncate_text(str(exc.detail).replace('\n', ' '), MAX_TOOL_STATUS_LINE),
                            state='error',
                        )
                    )
                    yield sse_line({'type': 'chunk', 'delta': exc.detail})
                    yield 'data: [DONE]\n\n'
                    return

                working_messages = [
                    SystemMessage(content=build_manager_system_prompt(session, apply_mode)),
                    *session_to_messages(session),
                    HumanMessage(content=user_message),
                ]
                outcome = ToolLoopOutcome()
                worker_out = ToolLoopOutcome()

                async def delegate_runner(args: dict[str, Any], _parent_tool_id: str) -> AsyncIterator[str]:
                    summary = (args.get('task_summary') or '').strip() or '(empty task summary)'
                    tools_w, map_w = worker_tools_and_map(apply_mode)
                    llm_w = llm_base.bind_tools(tools_w, parallel_tool_calls=parallel_tool_calls)
                    sub_messages: list[BaseMessage] = [
                        SystemMessage(content=build_worker_system_prompt(session, apply_mode)),
                        HumanMessage(content=f'Task:\n{summary}'),
                    ]
                    async for line in stream_classic_tool_loop(
                        sub_messages,
                        llm_w,
                        map_w,
                        session_id,
                        apply_mode,
                        outcome=worker_out,
                        agent_role='worker',
                        thinking_prefix='wkr',
                    ):
                        yield line

                async for line in stream_classic_tool_loop(
                    working_messages,
                    llm_mgr,
                    mgr_map,
                    session_id,
                    apply_mode,
                    outcome=outcome,
                    agent_role='manager',
                    thinking_prefix='mgr',
                    delegate_runner=delegate_runner,
                    delegate_outcome=worker_out,
                ):
                    yield line
                final_text = outcome.final_text

        session.history.append({'role': 'user', 'content': user_message})
        session.history.append({'role': 'assistant', 'content': final_text})

        yield 'data: [DONE]\n\n'
    except Exception as exc:
        yield sse_line(
            status_event(
                'fatal',
                'LangChain request failed',
                detail=f'{type(exc).__name__}: {exc}',
                state='error',
            )
        )
        yield sse_line({'type': 'chunk', 'delta': 'Error: the LangChain backend failed while generating a response.'})
        yield 'data: [DONE]\n\n'
    finally:
        current_session_id.reset(token)


__all__ = [
    'hitl_diff_pause_tools',
    'invoke_tool',
    'sse_line',
    'sse_tool_finished',
    'status_event',
    'stream_agent_reply',
    'stream_classic_tool_loop',
]
