"""Tell tools which batch of parallel tool calls they belong to."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.session.state import current_tool_batch_id


def tool_batch_id(tool_call: dict[str, Any], messages: Sequence[Any] | None) -> str:
    """Id of the model message that issued ``tool_call``, shared by every call in that message.

    LangGraph gives state messages ids; the object id is a fallback (the message stays in state, so the id is
    not reused while the batch runs). Empty when the call has no id or its message is not in ``messages``.
    """

    call_id = str(tool_call.get('id') or '')
    if not call_id:
        return ''
    for msg in reversed(messages or []):
        if isinstance(msg, AIMessage) and any(str(c.get('id') or '') == call_id for c in msg.tool_calls):
            return msg.id or f'message:{id(msg)}'
    return ''


class ToolBatchMiddleware(AgentMiddleware):
    """Set :data:`~clara_coder_backend.session.state.current_tool_batch_id` around each tool call.

    Edit tools use it to spot a line-range edit or whole-file rewrite whose file another call in the same
    response already changed.
    """

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        state = request.state
        messages = state.get('messages') if isinstance(state, dict) else None
        token = current_tool_batch_id.set(tool_batch_id(request.tool_call, messages))
        try:
            return await handler(request)
        finally:
            current_tool_batch_id.reset(token)
