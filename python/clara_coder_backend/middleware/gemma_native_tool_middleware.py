"""Promote Gemma native ``<|tool_call>`` markup into structured LangChain ``tool_calls``."""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import AgentState, ResponseT
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT
from typing_extensions import override

from clara_coder_backend.llm.gemma_output import extract_gemma_native_tool_calls
from clara_coder_backend.llm.messages import reasoning_sidecar_text, stringify_content

logger = logging.getLogger('clara.agent.langgraph')


def _gemma_native_tools_active() -> bool:
    """True when the Gemma optimization preset should promote native ``<|tool_call>`` markup."""
    try:
        from clara_coder_backend.llm.model_tuning import gemma_output_parsing_active
        from clara_coder_backend.session.state import get_active_connection

        return bool(gemma_output_parsing_active(get_active_connection()))
    except Exception:
        return False


def _candidate_texts(message: AIMessage) -> list[str]:
    texts: list[str] = []
    raw = stringify_content(message.content)
    if raw.strip():
        texts.append(raw)
    extra = str(getattr(message, 'text', None) or '')
    if extra.strip() and extra not in texts:
        texts.append(extra)
    reason = reasoning_sidecar_text(message)
    if reason.strip() and reason not in texts:
        texts.append(reason)
    return texts


class GemmaNativeToolMiddleware(AgentMiddleware):
    """Convert Gemma ``<|tool_call>call:name{...}<tool_call|>`` text into executable tool calls."""

    @override
    async def aafter_model(
        self,
        state: AgentState[ResponseT],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        if not _gemma_native_tools_active():
            return None
        msgs = state.get('messages') or []
        if not msgs:
            return None
        last = msgs[-1]
        if not isinstance(last, AIMessage):
            return None
        if last.tool_calls or getattr(last, 'invalid_tool_calls', None):
            return None
        calls: list[dict[str, Any]] = []
        for text in _candidate_texts(last):
            calls = extract_gemma_native_tool_calls(text)
            if calls:
                break
        if not calls:
            return None
        logger.info('Promoted Gemma native tool syntax to API tool_calls (%s call(s))', len(calls))
        return {'messages': [AIMessage(content='', tool_calls=calls)]}
