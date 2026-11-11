"""Map runtime LLM connection settings into LangChain ``create_agent`` model binding."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware

from clara_coder_backend.llm.model_tuning import effective_parallel_tool_calls, sends_parallel_tool_calls_field
from clara_coder_backend.session.state import get_active_connection


def _parallel_tool_calls_for_agent_request() -> bool:
    """Honor the connection's parallel-tool preference.

    Approval cards from parallel calls are staged per tool call and shown one at a time
    (:func:`~clara_coder_backend.session.pause.pause_for_tool_review`), and edits no longer pause, so parallel
    calls are safe in every mode.
    """
    return effective_parallel_tool_calls(get_active_connection())


def _with_parallel_tool_calls(request: Any) -> Any:
    settings = dict(request.model_settings)
    if sends_parallel_tool_calls_field(get_active_connection()):
        settings['parallel_tool_calls'] = _parallel_tool_calls_for_agent_request()
    else:
        settings.pop('parallel_tool_calls', None)
    return request.override(model_settings=settings)


class ConnectionParallelToolCallsMiddleware(AgentMiddleware):
    """Set ``parallel_tool_calls`` on each model request (mirrors classic ``bind_tools``)."""

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(_with_parallel_tool_calls(request))

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        return await handler(_with_parallel_tool_calls(request))
