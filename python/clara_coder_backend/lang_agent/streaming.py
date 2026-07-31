"""SSE helpers shared by classic and LangGraph agent paths."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

from langchain_core.messages import AIMessageChunk, BaseMessageChunk

from clara_coder_backend.session.config import MAX_READ_TOOL_STREAM_CHARS, MAX_TOOL_STATUS_LINE, TEXT_CHUNK_WORDS
from clara_coder_backend.hitl.tool_registry import WORKSPACE_READ_TOOL_NAMES

# Staged reads use the same multiplex preview lane as workspace reads in the UI.
_READ_TOOL_STREAM_PREVIEW_NAMES = WORKSPACE_READ_TOOL_NAMES | frozenset({'read_staged_edit'})
from clara_coder_backend.tools.workspace import truncate_text


def status_detail_one_line(detail: str, *, max_len: int = MAX_TOOL_STATUS_LINE) -> str:
    """Collapse status detail to a single line for UI labels."""
    line = detail.replace('\n', ' ').strip()
    return truncate_text(line, max_len) if line else ''


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
        'detail': status_detail_one_line(detail),
        'state': state,
        'source': source,
    }
    if agent_role:
        row['agent_role'] = agent_role
    if stream_tag:
        row['stream_tag'] = stream_tag
    return {'type': 'status', 'status': row}


def planner_progress_event(planner: dict[str, Any]) -> dict[str, Any]:
    """Structured plan checklist for the renderer (live + persisted assistant turns)."""
    return {'type': 'planner_progress', 'planner': planner}


def plan_confirm_event(payload: dict[str, Any]) -> dict[str, Any]:
    """HITL card payload before plan execution begins."""
    return {'type': 'plan_confirm', 'planConfirm': payload}


def agent_question_event(payload: dict[str, Any]) -> dict[str, Any]:
    """HITL card payload: batch of clarifying questions before plan confirm."""
    return {'type': 'agent_question', 'agentQuestion': payload}


def build_plan_open_event(payload: dict[str, Any]) -> dict[str, Any]:
    """Open the build-plan Markdown preview tab in the workspace UI."""
    return {'type': 'build_plan_open', 'buildPlanOpen': payload}


def build_plan_chunk_event(*, relative_path: str, content: str) -> dict[str, Any]:
    """Stream live build-plan markdown content to the workspace preview tab."""
    return {
        'type': 'build_plan_chunk',
        'buildPlanChunk': {'relativePath': relative_path, 'content': content},
    }


def build_plan_stream_end_event(*, relative_path: str) -> dict[str, Any]:
    """Signal that build-plan markdown streaming has finished."""
    return {
        'type': 'build_plan_stream_end',
        'buildPlanStreamEnd': {'relativePath': relative_path},
    }


def background_command_open_event(
    *,
    command_id: str,
    command_text: str,
    cwd_label: str,
    label: str,
    stream_tag: str,
) -> dict[str, Any]:
    """Open a read-only terminal tab in the workspace dock for a ``run_command`` job."""
    return {
        'type': 'background_command_open',
        'command_id': command_id,
        'command_text': command_text,
        'cwd_label': cwd_label,
        'label': label,
        'stream_tag': stream_tag,
    }


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
    outcome: str | None = None,
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
    if outcome in ('passed', 'failed'):
        row['outcome'] = outcome
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
    return raw


def aimessage_chunk_reasoning_delta(chunk: BaseMessageChunk) -> str:
    """Extract per-chunk reasoning / auxiliary text (OpenAI ``reasoning_content``, etc.)."""
    if not isinstance(chunk, AIMessageChunk):
        return ''
    r = getattr(chunk, 'reasoning', None)
    if isinstance(r, str) and r:
        return r
    ak = getattr(chunk, 'additional_kwargs', None) or {}
    for key in ('reasoning_content', 'reasoning'):
        val = ak.get(key)
        if isinstance(val, str) and val:
            return val
        if isinstance(val, dict):
            for sub in ('summary', 'text', 'content'):
                s = val.get(sub)
                if isinstance(s, str) and s:
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
    if tool_name not in _READ_TOOL_STREAM_PREVIEW_NAMES:
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
