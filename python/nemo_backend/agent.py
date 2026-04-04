"""SSE streaming agent: LangChain tool loop and chunked text output.

Yields Server-Sent Events lines consumed by the Electron renderer. Status events
report tool progress; chunk events carry answer text in small word groups.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, AsyncIterator

from fastapi import HTTPException
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

from nemo_backend.config import (
    MAX_AGENT_EMPTY_NUDGES,
    MAX_AGENT_LENGTH_CONTINUES,
    MAX_AGENT_STEPS,
    MAX_AGENT_TOOL_FORMAT_NUDGES,
    MAX_TOOL_STATUS_LINE,
    TEXT_CHUNK_WORDS,
)
from nemo_backend.llm import build_llm
from nemo_backend.messages import (
    build_system_prompt,
    final_assistant_text,
    session_to_messages,
    stringify_content,
    text_uses_pseudo_tool_markup,
)
from nemo_backend.state import current_session_id, get_active_connection, get_session
from nemo_backend.workspace_tools import TOOLS, TOOL_MAP, truncate_text


def status_event(
    status_id: str,
    label: str,
    *,
    detail: str = '',
    state: str = 'running',
    source: str = 'agent',
) -> dict[str, Any]:
    """Build one structured status payload for the UI (tool running, errors, etc.)."""
    return {
        'type': 'status',
        'status': {
            'id': status_id,
            'label': label,
            'detail': detail,
            'state': state,
            'source': source,
        },
    }


def chunk_text(text: str) -> list[str]:
    """Split assistant text into chunks of roughly TEXT_CHUNK_WORDS tokens for gradual SSE."""
    tokens = re.findall(r'\S+\s*', text)
    if not tokens:
        return [text] if text else []
    return [''.join(tokens[index : index + TEXT_CHUNK_WORDS]) for index in range(0, len(tokens), TEXT_CHUNK_WORDS)]


def _tool_result_one_line(text: str, max_len: int = MAX_TOOL_STATUS_LINE) -> str:
    """Collapse tool output to a single line for compact status display."""
    s = text.replace('\n', ' ').strip()
    if not s:
        return 'ok (empty)'
    if len(s) > max_len:
        return s[: max_len - 1] + '…'
    return s


def _tool_running_detail(tool_name: str, tool_args: Any) -> str:
    """Short hint for the UI while a tool runs (path, query, etc.)."""
    if not isinstance(tool_args, dict):
        return ''
    rp = tool_args.get('relative_path')
    if isinstance(rp, str) and rp.strip():
        return truncate_text(rp.strip(), MAX_TOOL_STATUS_LINE)
    q = tool_args.get('query')
    if isinstance(q, str) and q.strip():
        return truncate_text(q.strip().replace('\n', ' '), MAX_TOOL_STATUS_LINE)
    return ''


def sse_tool_finished(
    tool_id: str,
    tool_name: str,
    result_text: str,
    *,
    ok: bool,
    error_detail: str = '',
) -> str:
    """Single SSE line after invoke: complete with one-line result or error."""
    if not ok:
        line = truncate_text((error_detail or 'Error').replace('\n', ' '), MAX_TOOL_STATUS_LINE)
        return sse_line(status_event(tool_id, tool_name, detail=line, state='error', source='tool'))
    line = _tool_result_one_line(result_text)
    return sse_line(status_event(tool_id, tool_name, detail=line, state='complete', source='tool'))


def sse_line(payload: dict[str, Any]) -> str:
    """Format one SSE ``data:`` line (JSON body, UTF-8 preserved)."""
    return f'data: {json.dumps(payload, ensure_ascii=False)}\n\n'


async def invoke_tool(tool_name: str, args: dict[str, Any]) -> str:
    """Dispatch a structured tool call to our LangChain tool implementations."""
    tool_ = TOOL_MAP.get(tool_name)
    if tool_ is None:
        raise ValueError(f'Unknown tool: {tool_name}')
    result = await tool_.ainvoke(args)
    return stringify_content(result)


async def stream_agent_reply(session_id: str, user_message: str, _apply_mode: bool = True) -> AsyncIterator[str]:
    """Run the tool-capable agent and yield SSE lines until [DONE]."""
    session = get_session(session_id)
    get_active_connection()

    try:
        llm = build_llm().bind_tools(TOOLS, parallel_tool_calls=False)
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
        SystemMessage(content=build_system_prompt(session)),
        *session_to_messages(session),
        HumanMessage(content=user_message),
    ]
    final_text = ''
    token = current_session_id.set(session_id)

    try:
        finished_after_tool_phase = False
        reply_prefix_parts: list[str] = []
        length_continues = 0
        empty_final_nudges = 0
        tool_format_nudges = 0
        for step in range(1, MAX_AGENT_STEPS + 1):
            ai_message = await llm.ainvoke(working_messages)
            working_messages.append(ai_message)

            # Branch 1: model returned structured tool_calls — run each and append ToolMessage.
            if ai_message.tool_calls:
                for index, tool_call in enumerate(ai_message.tool_calls, start=1):
                    tool_name = tool_call.get('name', 'tool')
                    tool_args = tool_call.get('args', {})
                    tool_id = tool_call.get('id') or f'{step}-{index}'
                    yield sse_line(
                        status_event(
                            tool_id,
                            tool_name,
                            detail=_tool_running_detail(tool_name, tool_args),
                            state='running',
                            source='tool',
                        )
                    )
                    try:
                        tool_result = await invoke_tool(tool_name, tool_args)
                        working_messages.append(ToolMessage(content=tool_result, tool_call_id=tool_id))
                        yield sse_tool_finished(tool_id, tool_name, tool_result, ok=True)
                    except Exception as exc:
                        error_text = f'{type(exc).__name__}: {exc}'
                        working_messages.append(ToolMessage(content=f'Tool error: {error_text}', tool_call_id=tool_id))
                        yield sse_tool_finished(tool_id, tool_name, '', ok=False, error_detail=error_text)
                continue

            # Branch 2: parser saw a tool intent but arguments were invalid — ask model to fix.
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

            # Branch 3: final assistant text (visible content, else reasoning fallback).
            chunk = final_assistant_text(ai_message)
            meta = getattr(ai_message, 'response_metadata', None) or {}
            finish_reason = meta.get('finish_reason')

            # Empty answer: nudge a few times, then give up with a synthetic user-facing message.
            if not chunk:
                if empty_final_nudges < MAX_AGENT_EMPTY_NUDGES:
                    empty_final_nudges += 1
                    logging.getLogger('nemo.agent').info(
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
                logging.getLogger('nemo.agent').warning(
                    'Empty final assistant text after tool phase: content=%r additional_kwargs=%r '
                    'response_metadata=%r tool_calls=%r',
                    ai_message.content,
                    getattr(ai_message, 'additional_kwargs', {}),
                    meta,
                    getattr(ai_message, 'tool_calls', None),
                )
                break

            # Model wrote XML/tool prose instead of using the tool channel — corrective HumanMessage.
            if text_uses_pseudo_tool_markup(chunk) and tool_format_nudges < MAX_AGENT_TOOL_FORMAT_NUDGES:
                tool_format_nudges += 1
                logging.getLogger('nemo.agent').info(
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

            # Output truncated by provider: accumulate prefix and request continuation only.
            if finish_reason == 'length' and length_continues < MAX_AGENT_LENGTH_CONTINUES:
                reply_prefix_parts.append(chunk)
                length_continues += 1
                logging.getLogger('nemo.agent').info(
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

            # Normal completion: merge any length-continuation prefix with this segment.
            finished_after_tool_phase = True
            final_text = '\n\n'.join(reply_prefix_parts + [chunk]).strip()
            break

        # Fallback copy when the loop exits without a final segment (step limit or empty after nudges).
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

        session.history.append({'role': 'user', 'content': user_message})
        session.history.append({'role': 'assistant', 'content': final_text})

        for chunk in chunk_text(final_text):
            yield sse_line({'type': 'chunk', 'delta': chunk})
            await asyncio.sleep(0.01)
        yield 'data: [DONE]\n\n'
    except Exception as exc:
        yield sse_line(status_event('fatal', 'LangChain request failed', detail=f'{type(exc).__name__}: {exc}', state='error'))
        yield sse_line({'type': 'chunk', 'delta': 'Error: the LangChain backend failed while generating a response.'})
        yield 'data: [DONE]\n\n'
    finally:
        current_session_id.reset(token)
