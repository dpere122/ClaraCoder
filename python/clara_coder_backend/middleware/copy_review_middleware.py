"""After copy tool stages HITL, pause until the user continues (LangGraph)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.lang_agent.pause import await_diff_review_note
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.hitl.tool_registry import hitl_copy_pause_tools


class CopyReviewAfterToolMiddleware(AgentMiddleware):
    """Emit copy-confirm SSE (via queue), await agent-continue, then append an optional HumanMessage."""

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
        if (
            not sess.worker_apply_mode
            or name not in hitl_copy_pause_tools()
            or not sess.pending_copy_request
            or sess.auto_apply_mode
        ):
            return result

        q = sess.hitl_sse_queue
        if q is None:
            return result

        await q.put(('copy',))
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
