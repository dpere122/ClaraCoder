"""Promote pseudo XML tool markup into structured LangChain ``tool_calls``."""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import AgentState, ResponseT
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT
from typing_extensions import override

from clara_coder_backend.messages import extract_pseudo_tool_calls, final_assistant_text

logger = logging.getLogger('clara.agent.langgraph')


class PseudoToolXmlMiddleware(AgentMiddleware):
    """Convert ``<tool_call>`` / ``<function=...>`` text into executable tool calls."""

    @override
    async def aafter_model(
        self,
        state: AgentState[ResponseT],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        msgs = state.get('messages') or []
        if not msgs:
            return None
        last = msgs[-1]
        if not isinstance(last, AIMessage):
            return None
        if last.tool_calls or getattr(last, 'invalid_tool_calls', None):
            return None
        calls = extract_pseudo_tool_calls(final_assistant_text(last))
        if not calls:
            return None
        logger.info('Promoted pseudo XML tool syntax to API tool_calls (%s call(s))', len(calls))
        return {'messages': [AIMessage(content='', tool_calls=calls)]}
