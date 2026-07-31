"""After accept-command tools stage HITL, pause until the user continues."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.lang_agent.pause import await_diff_review_note
from clara_coder_backend.messages import stringify_content
from clara_coder_backend.state import current_session_id, get_session
from clara_coder_backend.tool_registry import hitl_accept_command_pause_tools


class AcceptCommandReviewAfterToolMiddleware(AgentMiddleware):
    """Emit accept-command SSE (via queue), await agent-continue, then fold output into the tool message."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        result = await handler(request)
        if isinstance(result, Command):
            return result
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
            base = stringify_content(tm.content).strip()
            merged = f'{base}\n\n---\n{note}'.strip() if base else note.strip()
            return ToolMessage(content=merged, tool_call_id=tm.tool_call_id, name=tm.name)
        return tm
