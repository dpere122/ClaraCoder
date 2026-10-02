"""After delete tool stages HITL, pause until the user continues (LangGraph)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.session.pause import hitl_tool_call_scope, pause_for_tool_review, tool_call_key
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.hitl.tool_registry import hitl_delete_pause_tools

_SLOT = 'pending_delete_request'


class DeleteReviewAfterToolMiddleware(AgentMiddleware):
    """Emit delete-confirm SSE (via queue), await agent-continue, then append optional HumanMessage."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        with hitl_tool_call_scope(tool_call_key(request.tool_call)) as staged:
            result = await handler(request)
        pending = staged.pop(_SLOT, None)
        session_id = current_session_id.get()
        if not session_id:
            return result

        name = str(request.tool_call.get('name') or '')
        sess = get_session(session_id)
        if (
            not sess.worker_apply_mode
            or name not in hitl_delete_pause_tools()
            or not pending
            or sess.auto_apply_mode
            or sess.hitl_sse_queue is None
        ):
            if pending:
                setattr(sess, _SLOT, pending)
            return result

        note = await pause_for_tool_review(session_id, ('delete',), {_SLOT: pending})

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
