"""Map runtime LLM connection settings into LangChain ``create_agent`` model binding."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware

from nemo_backend.model_tuning import effective_parallel_tool_calls
from nemo_backend.state import get_active_connection


class ConnectionParallelToolCallsMiddleware(AgentMiddleware):
    """Set ``parallel_tool_calls`` on each model request (mirrors classic ``bind_tools``)."""

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        conn = get_active_connection()
        merged = {
            **request.model_settings,
            'parallel_tool_calls': effective_parallel_tool_calls(conn),
        }
        return handler(request.override(model_settings=merged))

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        conn = get_active_connection()
        merged = {
            **request.model_settings,
            'parallel_tool_calls': effective_parallel_tool_calls(conn),
        }
        return await handler(request.override(model_settings=merged))
