"""LangGraph checkpoint message compaction to extend effective context window.

Lives under ``lang_agent`` (not ``llm``) because compaction reads/updates the outer
agent graph checkpoint via :func:`build_clara_single_outer_graph`.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from clara_coder_backend.lang_agent.graph import build_clara_single_outer_graph
from clara_coder_backend.session.checkpointing import outer_agent_thread_id
from clara_coder_backend.config import (
    CLARA_CONTEXT_COMPACT_ENABLED,
    CLARA_CONTEXT_COMPACT_OLD_TOOL_CHARS,
    CLARA_CONTEXT_COMPACT_PROTECT_TAIL,
    CLARA_CONTEXT_COMPACT_RECENT_TOOL_CHARS,
    CLARA_CONTEXT_COMPACT_SYSTEM_RESERVE_RATIO,
    CLARA_CONTEXT_COMPACT_TARGET_RATIO,
    CLARA_CONTEXT_COMPACT_TRIGGER_RATIO,
    CLARA_CONTEXT_WINDOW_FALLBACK,
)
from clara_coder_backend.domain import RuntimeContextCompressionConfig, SessionState
from clara_coder_backend.llm.factory import build_llm
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.session.state import get_active_connection, runtime_config
from clara_coder_backend.hitl.tool_registry import WORKSPACE_READ_TOOL_NAMES
from clara_coder_backend.tools.workspace import truncate_text, truncate_text_head_tail

logger = logging.getLogger('clara.context_compression')

_COMPACTED_PREFIX = '[compacted]'
_READ_PATH_RE = re.compile(r'^File:\s*(.+)$', re.MULTILINE)
_RECENT_BAND_OUTSIDE_TAIL = 12
_SEARCH_TOOL_NAMES = frozenset(
    {
        'search_workspace',
        'search_staged_edits',
        'retrieve_workspace_semantic',
        'retrieve_workspace_checkpoint_semantic',
    }
)
_EXEC_TOOL_NAME_MARKERS = (
    'pytest',
    'smoke',
    'overlay_command',
    'npm',
    'run_',
    'exec',
    'diagnostic',
)


@dataclass
class CompactResult:
    """Outcome of one post-turn checkpoint compaction pass."""

    ran: bool = False
    changed: bool = False
    tokens_before: int = 0
    tokens_after: int = 0
    tool_messages_compacted: int = 0
    tool_rounds_dropped: int = 0

    def to_sse_payload(self) -> dict[str, Any]:
        return {
            'type': 'context_compressed',
            'tokens_before': self.tokens_before,
            'tokens_after': self.tokens_after,
            'tool_messages_compacted': self.tool_messages_compacted,
            'tool_rounds_dropped': self.tool_rounds_dropped,
        }


def effective_compression_config() -> RuntimeContextCompressionConfig:
    """Merge runtime-config (Settings) with env-var fallbacks."""
    live = runtime_config.context_compression
    return RuntimeContextCompressionConfig(
        enabled=live.enabled if live is not None else CLARA_CONTEXT_COMPACT_ENABLED,
        trigger_ratio=live.trigger_ratio if live.trigger_ratio > 0 else CLARA_CONTEXT_COMPACT_TRIGGER_RATIO,
        target_ratio=live.target_ratio if live.target_ratio > 0 else CLARA_CONTEXT_COMPACT_TARGET_RATIO,
        protect_tail_messages=live.protect_tail_messages or CLARA_CONTEXT_COMPACT_PROTECT_TAIL,
        recent_tool_body_max_chars=live.recent_tool_body_max_chars or CLARA_CONTEXT_COMPACT_RECENT_TOOL_CHARS,
        old_tool_body_max_chars=live.old_tool_body_max_chars or CLARA_CONTEXT_COMPACT_OLD_TOOL_CHARS,
        system_reserve_ratio=live.system_reserve_ratio if live.system_reserve_ratio > 0 else CLARA_CONTEXT_COMPACT_SYSTEM_RESERVE_RATIO,
    )


def resolve_usable_budget_tokens() -> int:
    """Context window minus system/output reserve."""
    cfg = effective_compression_config()
    conn = get_active_connection()
    window = int(conn.context_window_tokens or 0)
    if window <= 0:
        window = CLARA_CONTEXT_WINDOW_FALLBACK
    reserve = max(0.0, min(0.5, float(cfg.system_reserve_ratio)))
    return max(1024, int(math.floor(window * (1.0 - reserve))))


def estimate_text_tokens(text: str) -> int:
    normalized = (text or '').strip()
    if not normalized:
        return 0
    try:
        import tiktoken

        enc = tiktoken.get_encoding('cl100k_base')
        return len(enc.encode(normalized))
    except Exception:
        return max(1, math.ceil(len(normalized) / 4))


def estimate_message_tokens(message: BaseMessage) -> int:
    overhead = 4
    if isinstance(message, ToolMessage):
        body = stringify_content(message.content)
        name = str(getattr(message, 'name', '') or '')
        return overhead + estimate_text_tokens(f'{name}\n{body}')
    if isinstance(message, AIMessage):
        body = stringify_content(message.content)
        planner = ''
        if message.tool_calls:
            planner = stringify_content(message.tool_calls)
        return overhead + estimate_text_tokens(body) + estimate_text_tokens(planner)
    if isinstance(message, (HumanMessage, SystemMessage)):
        return overhead + estimate_text_tokens(stringify_content(message.content))
    return overhead + estimate_text_tokens(stringify_content(getattr(message, 'content', '')))


def estimate_messages_tokens(messages: list[BaseMessage]) -> int:
    return sum(estimate_message_tokens(m) for m in messages)


def _extract_file_path(content: str) -> str:
    match = _READ_PATH_RE.search(content or '')
    if match:
        return match.group(1).strip()
    first = (content or '').splitlines()[0].strip() if content else ''
    return first[:120] if first else 'unknown'


def _is_exec_tool(name: str) -> bool:
    lower = name.lower()
    return any(marker in lower for marker in _EXEC_TOOL_NAME_MARKERS)


def _already_compacted(content: str) -> bool:
    return (content or '').lstrip().startswith(_COMPACTED_PREFIX)


def compact_tool_message_body(name: str, content: str, max_chars: int) -> str:
    """Shrink one tool result body to a bounded placeholder or excerpt."""
    body = content or ''
    if _already_compacted(body):
        return body
    if len(body) <= max_chars:
        return body

    tool_name = (name or '').strip()
    if tool_name in WORKSPACE_READ_TOOL_NAMES or tool_name in {'read_staged_edit', 'read_staged_edit_chunk'}:
        path = _extract_file_path(body)
        return f'{_COMPACTED_PREFIX} {tool_name}: {path} ({len(body)} chars). Re-call tool if needed.'

    if tool_name in _SEARCH_TOOL_NAMES or 'search' in tool_name.lower() or 'retrieve' in tool_name.lower():
        lines = body.splitlines()
        head = lines[:8]
        rest = max(0, len(lines) - len(head))
        summary = '\n'.join(head)
        if rest:
            summary += f'\n... [{rest} lines omitted — re-call tool if needed]'
        return truncate_text(summary, max_chars)

    if _is_exec_tool(tool_name):
        return truncate_text_head_tail(body, max_chars)

    return truncate_text(body, max_chars)


def _max_chars_for_index(index: int, total: int, cfg: RuntimeContextCompressionConfig) -> int | None:
    protect_start = max(0, total - cfg.protect_tail_messages)
    if index >= protect_start:
        return None
    recent_start = max(0, protect_start - _RECENT_BAND_OUTSIDE_TAIL)
    if index >= recent_start:
        return cfg.recent_tool_body_max_chars
    return cfg.old_tool_body_max_chars


def _clone_tool_message(message: ToolMessage, content: str) -> ToolMessage:
    return ToolMessage(
        content=content,
        tool_call_id=str(message.tool_call_id or ''),
        name=str(getattr(message, 'name', '') or ''),
        additional_kwargs=dict(getattr(message, 'additional_kwargs', None) or {}),
        response_metadata=dict(getattr(message, 'response_metadata', None) or {}),
    )


def _compact_tool_messages(
    messages: list[BaseMessage],
    cfg: RuntimeContextCompressionConfig,
) -> tuple[list[BaseMessage], int]:
    out: list[BaseMessage] = []
    compacted = 0
    total = len(messages)
    for i, msg in enumerate(messages):
        if not isinstance(msg, ToolMessage):
            out.append(msg)
            continue
        max_chars = _max_chars_for_index(i, total, cfg)
        if max_chars is None:
            out.append(msg)
            continue
        name = str(getattr(msg, 'name', '') or '')
        body = stringify_content(msg.content)
        new_body = compact_tool_message_body(name, body, max_chars)
        if new_body != body:
            compacted += 1
            out.append(_clone_tool_message(msg, new_body))
        else:
            out.append(msg)
    return out, compacted


def compact_checkpoint_messages(
    messages: list[BaseMessage],
    *,
    cfg: RuntimeContextCompressionConfig | None = None,
    budget_tokens: int | None = None,
) -> tuple[list[BaseMessage], CompactResult]:
    """Compact tool bodies when checkpoint estimate exceeds the trigger budget."""
    cfg = cfg or effective_compression_config()
    budget = budget_tokens if budget_tokens is not None else resolve_usable_budget_tokens()
    result = CompactResult()
    if not messages:
        return messages, result

    result.tokens_before = estimate_messages_tokens(messages)
    result.ran = True
    trigger_tokens = int(math.floor(budget * cfg.trigger_ratio))
    if result.tokens_before <= trigger_tokens:
        result.tokens_after = result.tokens_before
        return messages, result

    working, compacted_count = _compact_tool_messages(messages, cfg)
    result.tool_messages_compacted = compacted_count
    if compacted_count:
        result.changed = True

    result.tokens_after = estimate_messages_tokens(working)
    return working, result


async def maybe_compact_outer_checkpoint(
    session_id: str,
    apply_mode: bool,
    session: SessionState,
) -> CompactResult | None:
    """Compact the outer Clara checkpoint after a completed turn, if enabled."""
    cfg = effective_compression_config()
    if not cfg.enabled:
        return None

    try:
        llm = build_llm()
    except Exception as exc:
        logger.debug('context compression skipped (LLM bootstrap failed): %s', exc)
        return None

    graph = build_clara_single_outer_graph(llm, session, apply_mode)
    thread_id = outer_agent_thread_id(session_id, 'single', apply_mode=apply_mode)
    config: dict[str, Any] = {'configurable': {'thread_id': thread_id}}

    try:
        snap = await graph.aget_state(config)
    except Exception as exc:
        logger.debug('context compression skipped (aget_state failed): %s', exc)
        return None

    vals = getattr(snap, 'values', None) or {}
    raw_messages = vals.get('messages') if isinstance(vals, dict) else None
    if not isinstance(raw_messages, list) or not raw_messages:
        return None

    messages = [m for m in raw_messages if isinstance(m, BaseMessage)]
    if not messages:
        return None

    compacted, stats = compact_checkpoint_messages(messages, cfg=cfg)
    if not stats.changed:
        return stats

    try:
        await graph.aupdate_state(config, values={'messages': compacted})
    except Exception as exc:
        logger.warning('context compression aupdate_state failed: %s', exc)
        stats.changed = False
        return stats

    logger.info(
        'checkpoint compacted session=%s apply=%s before=%s after=%s compacted_tools=%s dropped_rounds=%s',
        session_id,
        apply_mode,
        stats.tokens_before,
        stats.tokens_after,
        stats.tool_messages_compacted,
        stats.tool_rounds_dropped,
    )
    return stats
