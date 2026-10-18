"""Map runtime LLM connection settings into LangChain ``create_agent`` model binding."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware

from clara_coder_backend.llm.model_tuning import effective_parallel_tool_calls
from clara_coder_backend.session.state import get_active_connection


def _parallel_tool_calls_for_agent_request() -> bool:
    """Honor the connection's parallel-tool preference.

    Approval cards from parallel calls are staged per tool call and shown one at a time
    (:func:`~clara_coder_backend.session.pause.pause_for_tool_review`), and edits no longer pause, so parallel
    calls are safe in every mode.
    """
    return effective_parallel_tool_calls(get_active_connection())


class ConnectionParallelToolCallsMiddleware(AgentMiddleware):
    """Set ``parallel_tool_calls`` on each model request (mirrors classic ``bind_tools``)."""

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        merged = {
            **request.model_settings,
            'parallel_tool_calls': _parallel_tool_calls_for_agent_request(),
        }
        return handler(request.override(model_settings=merged))

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        merged = {
            **request.model_settings,
            'parallel_tool_calls': _parallel_tool_calls_for_agent_request(),
        }
        return await handler(request.override(model_settings=merged))
