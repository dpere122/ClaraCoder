"""Augment ``ToolMessage`` content with brief coaching on success (allowlist) or ``Tool error:`` outcomes.

Registered **before** :class:`~nemo_backend.delete_review_middleware.DeleteReviewAfterToolMiddleware` and
:class:`~nemo_backend.diff_review_middleware.DiffReviewAfterToolMiddleware` so HITL layers still see the
final tool text the model will read.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.agents.planning.tool import MODIFY_WORKSPACE_NAME
from nemo_backend.agents.specialists.review_tools import TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME
from nemo_backend.delete_tool import DELETE_WORKSPACE_ENTRY_NAME
from nemo_backend.edit_tool import APPROVE_STAGED_WORKSPACE_EDIT_NAME
from nemo_backend.llm_coaching import tool_error_coaching_suffix, tool_success_coaching_suffix
from nemo_backend.messages import stringify_content
from nemo_backend.staging_edit_tools import (
    STAGE_CREATE_FILE_NAME,
    STAGE_LINE_RANGE_EDIT_NAME,
    STAGE_SNIPPET_EDIT_NAME,
)

# Planner-local tool names (defined inside coding_planner.pipeline).
_RECORD_PLAN_NAME = 'record_plan'
_EXECUTE_PLAN_STEP_NAME = 'execute_plan_step'

_TOOL_OUTCOME_SUCCESS_COACH_ALLOWLIST: frozenset[str] = frozenset(
    {
        MODIFY_WORKSPACE_NAME,
        _RECORD_PLAN_NAME,
        _EXECUTE_PLAN_STEP_NAME,
        TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME,
        DELETE_WORKSPACE_ENTRY_NAME,
        STAGE_CREATE_FILE_NAME,
        STAGE_LINE_RANGE_EDIT_NAME,
        STAGE_SNIPPET_EDIT_NAME,
        APPROVE_STAGED_WORKSPACE_EDIT_NAME,
    }
)


def _apply_coaching_to_text(name: str, text: str) -> str:
    stripped = text.strip()
    if text.startswith('Tool error:'):
        return text + tool_error_coaching_suffix()
    if stripped and name in _TOOL_OUTCOME_SUCCESS_COACH_ALLOWLIST:
        return text + tool_success_coaching_suffix(name)
    return text


def _coached_tool_message(tm: ToolMessage, tool_name: str) -> ToolMessage:
    original = stringify_content(tm.content)
    coached = _apply_coaching_to_text(tool_name, original)
    if coached == original:
        return tm
    return ToolMessage(
        content=coached,
        tool_call_id=str(tm.tool_call_id or ''),
        name=str(tm.name or tool_name),
    )


class ToolOutcomeCoachMiddleware(AgentMiddleware):
    """Wrap tool execution to append recovery or success coaching to tool results."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        result = await handler(request)
        name = str(request.tool_call.get('name') or '')

        if isinstance(result, Command):
            upd = getattr(result, 'update', None) or {}
            msgs = upd.get('messages')
            if not isinstance(msgs, list):
                return result
            new_list: list[Any] = []
            for m in msgs:
                if isinstance(m, ToolMessage):
                    new_list.append(_coached_tool_message(m, name))
                else:
                    new_list.append(m)
            return replace(result, update={**upd, 'messages': new_list})

        tm: ToolMessage
        if isinstance(result, ToolMessage):
            tm = result
        else:
            tm = ToolMessage(
                content=stringify_content(result),
                tool_call_id=str(request.tool_call.get('id') or ''),
                name=name,
            )
        return _coached_tool_message(tm, name)
