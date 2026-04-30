"""After accept-command tools stage HITL, pause until the user continues."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.agent_pause import await_diff_review_note
from nemo_backend.messages import stringify_content
from nemo_backend.state import current_session_id, get_session
from nemo_backend.tool_registry import hitl_accept_command_pause_tools


class AcceptCommandReviewAfterToolMiddleware(AgentMiddleware):
    """Emit accept-command SSE (via queue), await agent-continue, then append optional HumanMessage."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        result = await handler(request)
        session_id = current_session_id.get()
        if not session_id:
            return result

        name = str(request.tool_call.get('name') or '')
        sess = get_session(session_id)
        # Require an active SSE pump (``hitl_sse_queue``), not ``worker_apply_mode``: nested npm/pip
        # tools run during streamed agent work but ``worker_apply_mode`` is editor-only and could skip HITL.
        if (
            sess.hitl_sse_queue is None
            or name not in hitl_accept_command_pause_tools()
            or not sess.pending_accept_command_request
            or sess.auto_apply_mode
        ):
            return result

        await sess.hitl_sse_queue.put(('accept_command',))
        note = await await_diff_review_note(session_id)

        tm: ToolMessage
        if isinstance(result, ToolMessage):
            tm = result
        else:
            tm = ToolMessage(
                content=stringify_content(result),
                tool_call_id=str(request.tool_call.get('id') or ''),
                name=name,
            )
        if note:
            return Command(update={'messages': [tm, HumanMessage(content=note)]})
        return tm
