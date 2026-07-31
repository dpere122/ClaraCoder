"""Map runtime LLM connection settings into LangChain ``create_agent`` model binding."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware

from clara_coder_backend.llm.model_tuning import effective_parallel_tool_calls
from clara_coder_backend.session.state import current_session_id, get_active_connection, get_session


def _parallel_tool_calls_for_agent_request() -> bool:
    """Honor connection parallel-tool preference except when HITL review is active.

    Diff / copy / delete / accept-command pauses share single ``SessionState`` pending fields; concurrent
    tool execution can clobber payloads or emit duplicate queue signals before the UI confirms.
    """
    conn = get_active_connection()
    if not effective_parallel_tool_calls(conn):
        return False
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return True
    sess = get_session(sid)
    if sess.worker_apply_mode and not sess.auto_apply_mode:
        return False
    return True


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
