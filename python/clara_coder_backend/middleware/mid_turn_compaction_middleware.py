"""Compact older tool result bodies before each mid-turn model call."""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import BaseMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT

from clara_coder_backend.lang_agent.context_compression import (
    effective_compression_config,
    stale_tool_message_replacements,
)
from clara_coder_backend.session.state import current_session_id, get_session

logger = logging.getLogger('clara.mid_turn_compaction')


class MidTurnContextCompactionMiddleware(AgentMiddleware):
    """Age-based tool body compaction before each model call (no window-budget gate).

    Returns ``ToolMessage`` replacements with the same ``id`` so LangGraph
    ``add_messages`` overwrites checkpoint bodies. Emits ``context_compressed``
    on the session HITL SSE queue when something changed.
    """

    async def abefore_model(
        self,
        state: dict[str, Any],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        cfg = effective_compression_config()
        if not cfg.enabled:
            return None

        raw = state.get('messages') or []
        if not isinstance(raw, list) or not raw:
            return None
        messages = [m for m in raw if isinstance(m, BaseMessage)]
        if not messages:
            return None

        replacements, stats = stale_tool_message_replacements(messages, cfg=cfg)
        if not replacements or not stats.changed:
            return None

        logger.info(
            'mid-turn compact before=%s after=%s tools=%s',
            stats.tokens_before,
            stats.tokens_after,
            stats.tool_messages_compacted,
        )
        _emit_context_compressed_sse(stats.to_sse_payload())
        return {'messages': replacements}


def _emit_context_compressed_sse(payload: dict[str, Any]) -> None:
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return
    sess = get_session(sid)
    q = sess.hitl_sse_queue
    if q is None:
        return
    try:
        q.put_nowait(('context_compressed', payload))
    except Exception as exc:
        logger.debug('mid-turn compact SSE enqueue failed: %s', exc)
