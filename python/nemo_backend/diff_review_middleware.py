"""After edit tools that emit a diff, pause until the user continues (LangGraph worker)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.agent_pause import await_diff_review_note
from nemo_backend.messages import stringify_content
from nemo_backend.state import current_session_id, direct_workspace_edits_active, get_session
from nemo_backend.tool_registry import hitl_diff_pause_tools


class DiffReviewAfterToolMiddleware(AgentMiddleware):
    """Signal the SSE pump to emit a diff, await agent-continue, then append an optional HumanMessage."""

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
        direct = direct_workspace_edits_active(sess, apply_mode=sess.worker_apply_mode)
        payload = sess.pending_diff_payload
        pause_tools = hitl_diff_pause_tools(direct=direct)
        batch_payload = sess.pending_staged_transfer_batch_payload
        staged_transfer_pending = (
            sess.pending_staged_transfer_hitl is not None and batch_payload is not None
        )
        # Require an active SSE pump (``hitl_sse_queue``), not ``worker_apply_mode``: nested
        # specialist tools can run during streamed agent work while refcount edge cases exist.
        if (
            sess.hitl_sse_queue is None
            or (name not in pause_tools and not staged_transfer_pending)
            or (not payload and not batch_payload)
            or sess.auto_apply_mode
        ):
            return result

        if staged_transfer_pending:
            await sess.hitl_sse_queue.put(('staged_transfer_batch', batch_payload))
        elif payload:
            await sess.hitl_sse_queue.put(('diff', payload))
        else:
            return result
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
