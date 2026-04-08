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

from nemo_backend.agent_loop import NestedWorkerRunResult, NestedWorkerRunState, normalize_retry_budget
from nemo_backend.agents.coding_planner.pipeline import run_coding_planner_stream
from nemo_backend.agents.orchestration.nested_pipeline import NESTED_WORKER_STREAM_END, run_planning_nested_stream
from nemo_backend.config import NEMO_CODING_PLANNER_ENABLED, NEMO_WORKER_RESULT_MAX_CHARS
from nemo_backend.planner_graph_session import prepare_new_planner_graph_session
from nemo_backend.state import current_session_id, get_active_connection, get_session, mutation_tools_blocked_reason
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


def _tool_message(content: str, *, tool_call_id: str, name: str) -> ToolMessage:
    return ToolMessage(
        content=_truncate_for_outer_agent(content),
        tool_call_id=tool_call_id,
        name=name,
    )


def _clear_pending_hitl_requests(sess: Any) -> None:
    sess.pending_diff_payload = None
    sess.pending_delete_request = None
    sess.pending_copy_request = None
    sess.pending_accept_command_request = None


async def _wait_for_nested_terminal_signal(sess: Any, done_ev: asyncio.Event) -> NestedWorkerRunState:
    """Wait for either the nested-stream sentinel or a user abort."""

    done_task = asyncio.create_task(done_ev.wait())
    abort_task = asyncio.create_task(sess.abort_event.wait())
    try:
        await asyncio.wait((done_task, abort_task), return_when=asyncio.FIRST_COMPLETED)
        if done_ev.is_set():
            return NestedWorkerRunState.COMPLETED
        if sess.abort_event.is_set():
            return NestedWorkerRunState.ABORTED
        return NestedWorkerRunState.COMPLETED
    finally:
        for task in (done_task, abort_task):
            if task.done():
                continue
            task.cancel()
        for task in (done_task, abort_task):
            if task.done():
                continue
            try:
                await task
            except asyncio.CancelledError:
                pass


class PlanningNestedWorkerMiddleware(AgentMiddleware):
    """Runs the nested router + specialists graph and enqueues its stream for the outer agent SSE pump."""

    def __init__(self, checkpointer: Any) -> None:
        self._checkpointer = checkpointer

    async def _run_nested_attempt(
        self,
        *,
        sess: Any,
        session_id: str,
        current_task_summary: str,
        nested_q: Any,
        reentry_attempts: int,
        reentry_budget: int,
    ) -> NestedWorkerRunResult:
        done_ev = asyncio.Event()
        sess.planning_nested_done_event = done_ev
        try:
            try:
                prepare_new_planner_graph_session(sess, session_id)
                if NEMO_CODING_PLANNER_ENABLED:
                    logger.info(
                        'modify_workspace intercepted — routing through coding planner '
                        '(NEMO_CODING_PLANNER_ENABLED=True, graph_attempt=%s)',
                        reentry_attempts,
                    )
                    raw_final = await run_coding_planner_stream(
                        sess,
                        session_id,
                        current_task_summary,
                        nested_q,
                        self._checkpointer,
                    )
                else:
                    logger.info('modify_workspace intercepted — routing directly to planning router (planner disabled)')
                    raw_final = await run_planning_nested_stream(
                        sess,
                        session_id,
                        current_task_summary,
                        nested_q,
                        self._checkpointer,
                    )
            except Exception as exc:
                _clear_pending_hitl_requests(sess)
                err = f'{type(exc).__name__}: {exc}'
                return NestedWorkerRunResult(
                    state=NestedWorkerRunState.FAILED,
                    output_text=f'Tool error: {err}',
                    reentry_attempts=reentry_attempts,
                    retry_budget=reentry_budget,
                )

            terminal_state = await _wait_for_nested_terminal_signal(sess, done_ev)
            if terminal_state == NestedWorkerRunState.ABORTED:
                return NestedWorkerRunResult(
                    state=NestedWorkerRunState.ABORTED,
                    output_text='Aborted by user.',
                    reentry_attempts=reentry_attempts,
                    retry_budget=reentry_budget,
                )

            reentry_request = sess.pending_project_review_reentry
            if not NEMO_CODING_PLANNER_ENABLED or reentry_request is None:
                return NestedWorkerRunResult(
                    state=NestedWorkerRunState.COMPLETED,
                    output_text=raw_final,
                    reentry_attempts=reentry_attempts,
                    retry_budget=reentry_budget,
                )
            if reentry_attempts >= reentry_budget:
                sess.pending_project_review_reentry = None
                return NestedWorkerRunResult(
                    state=NestedWorkerRunState.RETRY_EXHAUSTED,
                    output_text=(
                        f'{raw_final}\n\n'
                        f'Planner reentry budget exhausted: PLAN_RETRY_ATTEMPTS_COUNT={reentry_budget}.'
                    ),
                    reentry_attempts=reentry_attempts,
                    retry_budget=reentry_budget,
                )
            return NestedWorkerRunResult(
                state=NestedWorkerRunState.RETRY,
                output_text=raw_final,
                next_task_summary=reentry_request.next_task_summary,
                reentry_attempts=reentry_attempts,
                retry_budget=reentry_budget,
            )
        finally:
            sess.planning_nested_done_event = None

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
        current_task_summary = task_summary
        reentry_attempts = 0
        reentry_budget = normalize_retry_budget(get_active_connection().plan_retry_attempts_count)
        while True:
            result = await self._run_nested_attempt(
                sess=sess,
                session_id=session_id,
                current_task_summary=current_task_summary,
                nested_q=nested_q,
                reentry_attempts=reentry_attempts,
                reentry_budget=reentry_budget,
            )
            if result.state == NestedWorkerRunState.RETRY:
                reentry_attempts += 1
                current_task_summary = result.next_task_summary or current_task_summary
                logger.info(
                    'Starting brand-new planner graph after project review failure '
                    '(attempt=%s budget=%s)',
                    reentry_attempts,
                    reentry_budget,
                )
                continue
            return _tool_message(
                result.output_text,
                tool_call_id=tool_call_id,
                name=name,
            )
