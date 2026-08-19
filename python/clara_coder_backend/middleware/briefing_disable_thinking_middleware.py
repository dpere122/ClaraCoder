"""Disable thinking on Clara's first model call of a turn (the pre-tool briefing)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage

from clara_coder_backend.llm.factory import build_llm


def is_clara_briefing_model_call(messages: list[Any]) -> bool:
    """True when this call is the opening reply of the current user turn (no tools yet)."""
    last_human = -1
    for i, msg in enumerate(messages):
        if isinstance(msg, HumanMessage):
            last_human = i
    tail = messages[last_human + 1 :] if last_human >= 0 else messages
    return not any(isinstance(msg, ToolMessage) for msg in tail)


class ClaraBriefingDisableThinkingMiddleware(AgentMiddleware):
    """Pin thinking off for the first model call of a stream that is still a briefing.

    Later tool-loop calls keep the connection's normal thinking settings. HITL pauses
    stay on the same middleware instance, so a continue after tools does not re-apply.
    """

    def __init__(self) -> None:
        super().__init__()
        self._briefing_done = False

    def _maybe_disable(self, request: Any) -> Any:
        if self._briefing_done:
            return request
        messages = getattr(request, 'messages', None) or []
        if not is_clara_briefing_model_call(list(messages)):
            self._briefing_done = True
            return request
        self._briefing_done = True
        try:
            return request.override(model=build_llm(disable_thinking=True))
        except Exception:
            return request

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(self._maybe_disable(request))

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        return await handler(self._maybe_disable(request))
