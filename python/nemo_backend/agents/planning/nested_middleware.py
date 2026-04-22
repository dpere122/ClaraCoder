"""Intercept outer nested-mutation tools on the LangGraph agent: stream nested router/specialists to SSE.

``plan_and_modify``: when the coding planner is enabled (default), delegates to
``run_coding_planner_orchestrated_stream`` (probe, fast path, or full planner graph), then the router/specialists
pipeline. When the planner is disabled, delegates directly to ``run_planning_nested_stream``.

``execute_workspace_mutation``: always delegates to ``run_planning_nested_stream`` (no coding planner), for single
focused mutations with the same staging and code-review behavior.

``disable_coding_planner_for_plan_and_modify=True``: ``plan_and_modify`` delegates only to
``run_planning_nested_stream`` so the coding planner graph is never invoked on that path.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.agent_loop import NestedWorkerRunResult, NestedWorkerRunState, normalize_retry_budget
from nemo_backend.agents.coding_planner.pipeline import run_coding_planner_orchestrated_stream
from nemo_backend.agents.orchestration.nested_pipeline import NESTED_WORKER_STREAM_END, run_planning_nested_stream
from nemo_backend.config import NEMO_CODING_PLANNER_ENABLED, NEMO_WORKER_RESULT_MAX_CHARS
from nemo_backend.planner_graph_session import prepare_new_planner_graph_session
from nemo_backend.state import (
    current_session_id,
    get_active_connection,
    get_session,
    mutation_tools_blocked_reason,
    runtime_config,
)
from nemo_backend.agents.planning.tool import NESTED_OUTER_MUTATION_TOOL_NAMES, PLAN_AND_MODIFY_NAME

logger = logging.getLogger('nemo.agent.langgraph.planning')

__all__ = ['NESTED_WORKER_STREAM_END', 'PlanningNestedWorkerMiddleware']


def _truncate_for_outer_agent(text: str) -> str:
    if len(text) <= NEMO_WORKER_RESULT_MAX_CHARS:
        return text
    return (
        text[:NEMO_WORKER_RESULT_MAX_CHARS]
        + '\n\n[Nested workspace output truncated for outer context; increase NEMO_WORKER_RESULT_MAX_CHARS if needed.]'
    )


def _append_plan_and_modify_outer_briefs(sess: Any, content: str) -> str:
    briefs = getattr(sess, 'plan_and_modify_outer_briefs', None) or []
    if not briefs:
        return content
    return (
        content
        + '\n\n---\nNotes for Clara (summarize for the user; do not paste raw nested logs):\n\n'
        + '\n\n'.join(briefs)
    )


def _nested_delegation_outer_header(run_id: str) -> str:
    return (
        f'[Nested delegation result · run={run_id}]\n'
        'Graph: nested mutation pipeline (LangGraph threads separate from outer Clara).\n'
        'Tool names in the body refer to nested specialists—the outer agent list may differ.\n'
        '---\n'
    )


def _tool_message_nested_result(
    body: str,
    *,
    run_id: str,
    tool_call_id: str,
    name: str,
) -> ToolMessage:
    truncated = _truncate_for_outer_agent(body)
    return ToolMessage(
        content=_nested_delegation_outer_header(run_id) + truncated,
        tool_call_id=tool_call_id,
        name=name,
    )


def _clear_pending_hitl_requests(sess: Any) -> None:
    sess.pending_diff_payload = None
    sess.pending_staged_transfer_hitl = None
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

    def __init__(
        self,
        checkpointer: Any,
        *,
        disable_coding_planner_for_plan_and_modify: bool = False,
    ) -> None:
        self._checkpointer = checkpointer
        self._disable_coding_planner_for_plan_and_modify = disable_coding_planner_for_plan_and_modify

    async def _run_nested_attempt(
        self,
        *,
        sess: Any,
        session_id: str,
        current_task_summary: str,
        nested_q: Any,
        retry_budget: int,
        route_via_coding_planner: bool,
    ) -> NestedWorkerRunResult:
        done_ev = asyncio.Event()
        sess.planning_nested_done_event = done_ev
        try:
            try:
                prepare_new_planner_graph_session(sess, session_id)
                sess.nested_turn_apply_mode = True
                sess.nested_turn_auto_apply_mode = bool(sess.auto_apply_mode)
                sess.nested_turn_orchestrated_mode = bool(runtime_config.tools.orchestrated_mode)
                if route_via_coding_planner and NEMO_CODING_PLANNER_ENABLED:
                    logger.info(
                        'plan_and_modify intercepted — routing through coding planner '
                        '(NEMO_CODING_PLANNER_ENABLED=True)',
                    )
                    raw_final = await run_coding_planner_orchestrated_stream(
                        sess,
                        session_id,
                        current_task_summary,
                        nested_q,
                        self._checkpointer,
                    )
                elif route_via_coding_planner:
                    logger.info('plan_and_modify intercepted — routing directly to planning router (planner disabled)')
                    raw_final = await run_planning_nested_stream(
                        sess,
                        session_id,
                        current_task_summary,
                        nested_q,
                        self._checkpointer,
                    )
                else:
                    logger.info(
                        'Nested mutation tool intercepted — routing to planning router only (coding planner skipped)',
                    )
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
                    reentry_attempts=0,
                    retry_budget=retry_budget,
                )

            terminal_state = await _wait_for_nested_terminal_signal(sess, done_ev)
            if terminal_state == NestedWorkerRunState.ABORTED:
                return NestedWorkerRunResult(
                    state=NestedWorkerRunState.ABORTED,
                    output_text='Aborted by user.',
                    reentry_attempts=0,
                    retry_budget=retry_budget,
                )

            return NestedWorkerRunResult(
                state=NestedWorkerRunState.COMPLETED,
                output_text=raw_final,
                reentry_attempts=0,
                retry_budget=retry_budget,
            )
        finally:
            sess.planning_nested_done_event = None
            sess.nested_turn_apply_mode = None
            sess.nested_turn_auto_apply_mode = None
            sess.nested_turn_orchestrated_mode = None

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        name = str(request.tool_call.get('name') or '')
        if name not in NESTED_OUTER_MUTATION_TOOL_NAMES:
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
        retry_budget = normalize_retry_budget(get_active_connection().plan_retry_attempts_count)
        route_via_coding_planner = (
            name == PLAN_AND_MODIFY_NAME and not self._disable_coding_planner_for_plan_and_modify
        )
        result = await self._run_nested_attempt(
            sess=sess,
            session_id=session_id,
            current_task_summary=task_summary,
            nested_q=nested_q,
            retry_budget=retry_budget,
            route_via_coding_planner=route_via_coding_planner,
        )
        run_id = uuid.uuid4().hex[:12]
        return _tool_message_nested_result(
            _append_plan_and_modify_outer_briefs(sess, result.output_text),
            run_id=run_id,
            tool_call_id=tool_call_id,
            name=name,
        )
