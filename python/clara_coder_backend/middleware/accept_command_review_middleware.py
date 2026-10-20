"""After accept-command tools stage HITL, pause until the user continues."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.session.pause import hitl_tool_call_scope, pause_for_tool_review, tool_call_key
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.hitl.tool_registry import accept_command_pause_applies

_SLOT = 'pending_accept_command_request'


class AcceptCommandReviewAfterToolMiddleware(AgentMiddleware):
    """Emit accept-command SSE (via queue), await agent-continue, then fold output into the tool message."""

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
        # Require an active SSE pump (``hitl_sse_queue``), not ``worker_apply_mode``: nested npm/pip
        # tools run during streamed agent work but ``worker_apply_mode`` is editor-only and could skip HITL.
        # Do not skip on ``auto_apply_mode``: ordinary deferred tools never stage a pending request
        # when auto-apply is on, but agent-requested Admin elevation still must pause the composer chip.
        if (
            isinstance(result, Command)
            or sess.hitl_sse_queue is None
            or not accept_command_pause_applies(name)
            or not pending
        ):
            if pending:
                setattr(sess, _SLOT, pending)
            return result

        note = await pause_for_tool_review(
            session_id,
            ('accept_command',),
            {_SLOT: pending},
            tool_call_id=str(request.tool_call.get('id') or ''),
        )

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
