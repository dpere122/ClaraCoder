"""Intercept ``modify_workspace`` on the LangGraph outer agent: stream nested router/specialists to SSE.

When the coding planner is enabled (default), delegates to ``run_coding_planner_stream`` which
reads workspace files, plans the work, then executes steps through the router/specialists pipeline.
When disabled, delegates directly to ``run_planning_nested_stream`` (the router) as before.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.agents.coding_planner.pipeline import run_coding_planner_stream
from nemo_backend.agents.orchestration.nested_pipeline import NESTED_WORKER_STREAM_END, run_planning_nested_stream
from nemo_backend.config import NEMO_CODING_PLANNER_ENABLED, NEMO_WORKER_RESULT_MAX_CHARS
from nemo_backend.state import current_session_id, get_session, mutation_tools_blocked_reason
from nemo_backend.tool_registry import MODIFY_WORKSPACE_NAME

logger = logging.getLogger('nemo.agent.langgraph.planning')

__all__ = ['NESTED_WORKER_STREAM_END', 'PlanningNestedWorkerMiddleware']


def _truncate_for_outer_agent(text: str) -> str:
    if len(text) <= NEMO_WORKER_RESULT_MAX_CHARS:
        return text
    return (
        text[:NEMO_WORKER_RESULT_MAX_CHARS]
        + '\n\n[Nested workspace output truncated for outer context; increase NEMO_WORKER_RESULT_MAX_CHARS if needed.]'
    )


class PlanningNestedWorkerMiddleware(AgentMiddleware):
    """Runs the nested router + specialists graph and enqueues its stream for the outer agent SSE pump."""

    def __init__(self, checkpointer: Any) -> None:
        self._checkpointer = checkpointer

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        name = str(request.tool_call.get('name') or '')
        if name != MODIFY_WORKSPACE_NAME:
            return await handler(request)

        session_id = current_session_id.get()
        tool_call_id = str(request.tool_call.get('id') or '')
        if not session_id:
            return ToolMessage(
                content='Tool error: missing session context',
                tool_call_id=tool_call_id or 'planning',
                name=name,
            )

        sess = get_session(session_id)
        blocked = mutation_tools_blocked_reason(session_id)
        if blocked:
            return ToolMessage(
                content=blocked,
                tool_call_id=tool_call_id or 'planning',
                name=name,
            )
        nested_q = sess.planning_nested_events_q
        if nested_q is None:
            return ToolMessage(
                content='Tool error: planning stream not initialized',
                tool_call_id=tool_call_id,
                name=name,
            )

        raw_args = request.tool_call.get('args')
        args: dict[str, Any] = raw_args if isinstance(raw_args, dict) else {}
        task_summary = (args.get('task_summary') or '').strip() or '(empty task summary)'

        done_ev = asyncio.Event()
        sess.planning_nested_done_event = done_ev
        try:
            try:
                if NEMO_CODING_PLANNER_ENABLED:
                    logger.info('modify_workspace intercepted — routing through coding planner (NEMO_CODING_PLANNER_ENABLED=True)')
                    raw_final = await run_coding_planner_stream(
                        sess, session_id, task_summary, nested_q, self._checkpointer
                    )
                else:
                    logger.info('modify_workspace intercepted — routing directly to planning router (planner disabled)')
                    raw_final = await run_planning_nested_stream(
                        sess, session_id, task_summary, nested_q, self._checkpointer
                    )
            except Exception as exc:
                sess.pending_diff_payload = None
                sess.pending_delete_request = None
                sess.pending_copy_request = None
                err = f'{type(exc).__name__}: {exc}'
                return ToolMessage(
                    content=f'Tool error: {err}',
                    tool_call_id=tool_call_id,
                    name=name,
                )
            await done_ev.wait()
            return ToolMessage(
                content=_truncate_for_outer_agent(raw_final),
                tool_call_id=tool_call_id,
                name=name,
            )
        finally:
            sess.planning_nested_done_event = None
