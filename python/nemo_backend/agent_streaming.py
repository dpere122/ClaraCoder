"""SSE helpers shared by classic and LangGraph agent paths."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

from langchain_core.messages import AIMessageChunk, BaseMessageChunk

from nemo_backend.config import MAX_READ_TOOL_STREAM_CHARS, MAX_TOOL_STATUS_LINE, TEXT_CHUNK_WORDS
from nemo_backend.llm_visible_text import (
    is_placeholder_stream_delta,
    is_placeholder_thinking_noise,
    scrub_gemma_pipe_tags_fragment,
    strip_pseudo_tool_call_xml,
)
from nemo_backend.tool_registry import WORKSPACE_READ_TOOL_NAMES
from nemo_backend.workspace_tools import truncate_text


def status_event(
    status_id: str,
    label: str,
    *,
    detail: str = '',
    state: str = 'running',
    source: str = 'agent',
    agent_role: str | None = None,
    stream_tag: str | None = None,
) -> dict[str, Any]:
    """Build one structured status payload for the UI (tool running, errors, etc.)."""
    row: dict[str, Any] = {
        'id': status_id,
        'label': label,
        'detail': detail,
        'state': state,
        'source': source,
    }
    if agent_role:
        row['agent_role'] = agent_role
    if stream_tag:
        row['stream_tag'] = stream_tag
    return {'type': 'status', 'status': row}


def planner_progress_event(planner: dict[str, Any]) -> dict[str, Any]:
    """Build one structured planner progress payload for the UI."""
    return {'type': 'planner', 'planner': planner}


def tool_exec_chunk_event(delta: str, *, stream_tag: str | None = None, label: str = '') -> dict[str, Any]:
    """Build one structured live tool execution output payload for the UI."""
    row: dict[str, Any] = {'type': 'tool_exec_chunk', 'delta': delta}
    if stream_tag:
        row['stream_tag'] = stream_tag
    if label:
        row['label'] = label
    return row


def tool_exec_complete_event(
    *,
    stream_tag: str | None = None,
    label: str = '',
    exit_code: int | None = None,
    output_excerpt: str = '',
) -> dict[str, Any]:
    """Signal that a subprocess-style tool stream has finished (optional exit code for the badge)."""
    row: dict[str, Any] = {'type': 'tool_exec_complete', 'exit_code': exit_code}
    if stream_tag:
        row['stream_tag'] = stream_tag
    if label:
        row['label'] = label
    ex = output_excerpt.strip()
    if ex:
        row['output_excerpt'] = ex
    return row


def aimessage_chunk_sse_delta(chunk: BaseMessageChunk) -> str:
    """Extract user-visible text delta from one streamed chat-model chunk (OpenAI-compatible)."""
    if not isinstance(chunk, AIMessageChunk):
        return ''
    text = getattr(chunk, 'text', None)
    content = getattr(chunk, 'content', None)
    raw = ''
    if isinstance(text, str) and text:
        raw = text
    elif isinstance(content, str) and content:
        raw = content
    elif isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                btype = str(block.get('type') or '').strip().lower()
                if btype in ('tool_use', 'tool_call', 'function'):
                    continue
                t = block.get('text')
                if isinstance(t, str):
                    parts.append(t)
                else:
                    c = block.get('content')
                    if isinstance(c, str):
                        parts.append(c)
        raw = ''.join(parts)
    raw = scrub_gemma_pipe_tags_fragment(strip_pseudo_tool_call_xml(raw))
    if is_placeholder_stream_delta(raw) or is_placeholder_thinking_noise(raw):
        return ''
    return raw


def aimessage_chunk_reasoning_delta(chunk: BaseMessageChunk) -> str:
    """Extract per-chunk reasoning / auxiliary text (OpenAI ``reasoning_content``, etc.)."""
    if not isinstance(chunk, AIMessageChunk):
        return ''
    r = getattr(chunk, 'reasoning', None)
    if isinstance(r, str) and r:
        if is_placeholder_stream_delta(r) or is_placeholder_thinking_noise(r):
            return ''
        return r
    ak = getattr(chunk, 'additional_kwargs', None) or {}
    for key in ('reasoning_content', 'reasoning'):
        val = ak.get(key)
        if isinstance(val, str) and val:
            if is_placeholder_stream_delta(val) or is_placeholder_thinking_noise(val):
                return ''
            return val
        if isinstance(val, dict):
            for sub in ('summary', 'text', 'content'):
                s = val.get(sub)
                if isinstance(s, str) and s:
                    if is_placeholder_stream_delta(s) or is_placeholder_thinking_noise(s):
                        return ''
                    return s
    return ''


def is_meaningful_stream_delta(delta: str) -> bool:
    """Drop empty or space-only noise; keep any delta that includes a line break or visible text.

    Newline-only chunks (e.g. ``\\n\\n`` between paragraphs) must pass through—otherwise the
    saved assistant message loses markdown structure (headings, lists, code fences rely on breaks).
    """
    if not delta:
        return False
    if '\n' in delta or '\r' in delta:
        return True
    return not delta.isspace()


def iter_read_tool_stream_sse(tool_name: str, tool_result: str) -> Iterator[str]:
    """Yield SSE ``tool_read_chunk`` lines (separate channel from model ``chunk`` in the Electron UI)."""
    if tool_name not in WORKSPACE_READ_TOOL_NAMES:
        return
    body = tool_result
    if len(body) > MAX_READ_TOOL_STREAM_CHARS:
        body = body[:MAX_READ_TOOL_STREAM_CHARS] + '\n\n… [truncated for stream preview]\n'
    formatted = f'\n\n── {tool_name} ──\n{body}\n'
    for piece in chunk_text(formatted):
        if is_meaningful_stream_delta(piece):
            yield sse_line({'type': 'tool_read_chunk', 'delta': piece})


def chunk_text(text: str) -> list[str]:
    """Split assistant text into chunks of roughly TEXT_CHUNK_WORDS tokens for gradual SSE."""
    tokens = re.findall(r'\S+\s*', text)
    if not tokens:
        return [text] if text else []
    return [''.join(tokens[index : index + TEXT_CHUNK_WORDS]) for index in range(0, len(tokens), TEXT_CHUNK_WORDS)]


def tool_result_one_line(text: str, max_len: int = MAX_TOOL_STATUS_LINE) -> str:
    s = text.replace('\n', ' ').strip()
    if not s:
        return 'ok (empty)'
    if len(s) > max_len:
        return s[: max_len - 1] + '…'
    return s


def tool_running_detail(tool_name: str, tool_args: Any) -> str:
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
    agent_role: str | None = None,
    stream_tag: str | None = None,
) -> str:
    if not ok:
        line = truncate_text((error_detail or 'Error').replace('\n', ' '), MAX_TOOL_STATUS_LINE)
        return sse_line(
            status_event(
                tool_id,
                tool_name,
                detail=line,
                state='error',
                source='tool',
                agent_role=agent_role,
                stream_tag=stream_tag,
            )
        )
    line = tool_result_one_line(result_text)
    return sse_line(
        status_event(
            tool_id,
            tool_name,
            detail=line,
            state='complete',
            source='tool',
            agent_role=agent_role,
            stream_tag=stream_tag,
        )
    )


def sse_line(payload: dict[str, Any]) -> str:
    return f'data: {json.dumps(payload, ensure_ascii=False)}\n\n'


def model_chunk_payload(delta: str, stream_tag: str | None = None) -> dict[str, Any]:
    """JSON body for a user-visible model token delta (optional ``stream_tag`` for multiplexed subgraphs)."""
    row: dict[str, Any] = {'type': 'chunk', 'delta': delta}
    if stream_tag:
        row['stream_tag'] = stream_tag
    return row


def model_chunk_sse_line(delta: str, stream_tag: str | None = None) -> str:
    return sse_line(model_chunk_payload(delta, stream_tag))
