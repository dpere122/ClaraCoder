"""Auto-activate context packs on first matching tool use and prepend playbook text."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.context_packs.activation import (
    maybe_activate_for_tool,
    relative_path_from_tool_args,
)
from clara_coder_backend.session.state import current_session_id, get_session


def _prepend_to_tool_message(tm: ToolMessage, prefix_merged_content: Any) -> ToolMessage:
    if prefix_merged_content is tm.content:
        return tm
    return ToolMessage(
        content=prefix_merged_content,
        tool_call_id=str(getattr(tm, 'tool_call_id', '') or ''),
        name=str(getattr(tm, 'name', '') or ''),
    )


def _augment_command(result: Command, tool_name: str, *, relative_path: str | None) -> Command:
    sid = (current_session_id.get() or '').strip()
    if not sid:
        return result
    session = get_session(sid)
    upd = getattr(result, 'update', None)
    if not isinstance(upd, dict):
        return result
    msgs = upd.get('messages')
    if not isinstance(msgs, list):
        return result
    out_msgs: list[Any] = []
    changed = False
    for m in msgs:
        if isinstance(m, ToolMessage) and not changed:
            new_content = maybe_activate_for_tool(
                session, tool_name, m.content, relative_path=relative_path
            )
            new_tm = _prepend_to_tool_message(m, new_content)
            if new_tm is not m:
                changed = True
            out_msgs.append(new_tm)
        else:
            out_msgs.append(m)
    if not changed:
        return result
    return Command(update={**upd, 'messages': out_msgs})


class ContextPackActivationMiddleware(AgentMiddleware):
    """On first matching tool call, inject registered context-pack playbooks into the result."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        name = str(request.tool_call.get('name') or '')
        rel = relative_path_from_tool_args(request.tool_call.get('args'))
        result = await handler(request)
        sid = (current_session_id.get() or '').strip()
        if not sid:
            return result
        session = get_session(sid)
        if isinstance(result, Command):
            return _augment_command(result, name, relative_path=rel)
        if isinstance(result, ToolMessage):
            new_content = maybe_activate_for_tool(
                session, name, result.content, relative_path=rel
            )
            return _prepend_to_tool_message(result, new_content)
        return result
