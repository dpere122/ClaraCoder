"""After edit tools that emit a diff, pause until the user continues (LangGraph worker)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.session.pause import hitl_tool_call_scope, pause_for_tool_review, tool_call_key
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.session.state import current_session_id, direct_workspace_edits_active, get_session
from clara_coder_backend.hitl.tool_registry import hitl_diff_pause_tools


def _fold_note_into_tool_message(tm: ToolMessage, note: str) -> ToolMessage:
    """Keep transfer HITL outcomes on the tool channel (avoids a new Gemma user turn)."""
    base = stringify_content(tm.content).strip()
    merged = f'{base}\n\n---\n{note}'.strip() if base else note.strip()
    return ToolMessage(content=merged, tool_call_id=tm.tool_call_id, name=tm.name)


class DiffReviewAfterToolMiddleware(AgentMiddleware):
    """Signal the SSE pump to emit a diff, await agent-continue, then attach the resume note."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        with hitl_tool_call_scope(tool_call_key(request.tool_call)) as staged:
            result = await handler(request)
        payload = staged.pop('pending_diff_payload', None)
        transfer = staged.pop('pending_staged_transfer_hitl', None)
        batch_payload = staged.pop('pending_staged_transfer_batch_payload', None)
        session_id = current_session_id.get()
        if not session_id:
            return result

        name = str(request.tool_call.get('name') or '')
        sess = get_session(session_id)
        direct = direct_workspace_edits_active(sess, apply_mode=sess.worker_apply_mode)
        pause_tools = hitl_diff_pause_tools(direct=direct)
        staged_transfer_pending = transfer is not None and batch_payload is not None
        # Require an active SSE pump (``hitl_sse_queue``), not ``worker_apply_mode``: nested
        # specialist tools can run during streamed agent work while refcount edge cases exist.
        if (
            sess.hitl_sse_queue is None
            or (name not in pause_tools and not staged_transfer_pending)
            or (not payload and not staged_transfer_pending)
            or sess.auto_apply_mode
        ):
            for slot, value in (
                ('pending_diff_payload', payload),
                ('pending_staged_transfer_hitl', transfer),
                ('pending_staged_transfer_batch_payload', batch_payload),
            ):
                if value is not None:
                    setattr(sess, slot, value)
            return result

        if staged_transfer_pending:
            note = await pause_for_tool_review(
                session_id,
                ('staged_transfer_batch', batch_payload),
                {'pending_staged_transfer_hitl': transfer, 'pending_staged_transfer_batch_payload': batch_payload},
            )
        else:
            note = await pause_for_tool_review(session_id, ('diff', payload), {'pending_diff_payload': payload})

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
            # Staged-transfer confirm/re-review is the tool outcome. A follow-up HumanMessage
            # looks like a new user turn to Gemma and it restarts the original request.
            if staged_transfer_pending:
                return _fold_note_into_tool_message(tm, note)
            return Command(update={'messages': [tm, HumanMessage(content=note)]})
        return tm
