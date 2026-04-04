"""Intercept ``delegate_workspace_task`` on the LangGraph manager: stream nested worker graph events to the SSE loop."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.config import MAX_AGENT_STEPS, NEMO_WORKER_RESULT_MAX_CHARS
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.domain import SessionState
from nemo_backend.llm import build_llm
from nemo_backend.messages import build_worker_system_prompt, final_assistant_text
from nemo_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from nemo_backend.state import current_session_id, get_session
from nemo_backend.tool_registry import DELEGATE_WORKSPACE_TASK_NAME, worker_tools_and_map

logger = logging.getLogger('nemo.agent.langgraph.delegate')

# Pushed after the nested worker graph finishes so the manager SSE loop can signal the middleware.
NESTED_WORKER_STREAM_END = object()


def _truncate_for_manager(text: str) -> str:
    if len(text) <= NEMO_WORKER_RESULT_MAX_CHARS:
        return text
    return (
        text[:NEMO_WORKER_RESULT_MAX_CHARS]
        + '\n\n[Worker output truncated for manager context; increase NEMO_WORKER_RESULT_MAX_CHARS if needed.]'
    )


async def run_nested_worker_delegate_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: asyncio.Queue[Any],
    checkpointer: Any,
) -> str:
    """Run the worker ``create_agent`` graph; enqueue LangGraph v2 events, then ``NESTED_WORKER_STREAM_END``."""
    last_final_text = ''
    apply_mode = session.worker_apply_mode
    try:
        llm = build_llm()
    except Exception:
        await nested_q.put(NESTED_WORKER_STREAM_END)
        raise

    tools, _ = worker_tools_and_map(apply_mode)
    system_prompt = build_worker_system_prompt(session, apply_mode)
    graph = create_agent(
        llm,
        tools,
        system_prompt=system_prompt,
        name='nemo_worker_nested',
        middleware=[
            ConnectionParallelToolCallsMiddleware(),
            DiffReviewAfterToolMiddleware(),
        ],
        checkpointer=checkpointer,
    )
    thread_id = f'{session_id}:worker:{uuid.uuid4().hex[:10]}'
    config: RunnableConfig = {
        'configurable': {'thread_id': thread_id},
        'recursion_limit': MAX_AGENT_STEPS,
    }
    inputs: dict[str, Any] = {'messages': [HumanMessage(content=f'Task:\n{task_summary.strip()}')]}
    try:
        async for ev in graph.astream_events(inputs, config, version='v2'):
            await nested_q.put(ev)
            et = ev.get('event')
            data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
            if et == 'on_chat_model_end':
                raw = data.get('output')
                msg = raw if isinstance(raw, AIMessage) else None
                if msg is not None and not (msg.tool_calls or []):
                    last_final_text = final_assistant_text(msg)
    except Exception:
        logger.exception('Nested worker graph failed')
        raise
    finally:
        await nested_q.put(NESTED_WORKER_STREAM_END)

    if not last_final_text.strip():
        last_final_text = (
            'The workspace worker finished without a final text response. '
            'Try rephrasing the task or set NEMO_USE_LANGGRAPH_AGENT=false to use the classic worker.'
        )
    return last_final_text


class DelegateNestedWorkerMiddleware(AgentMiddleware):
    """Runs the workspace worker graph and enqueues its stream for the manager SSE pump."""

    def __init__(self, checkpointer: Any) -> None:
        self._checkpointer = checkpointer

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        name = str(request.tool_call.get('name') or '')
        if name != DELEGATE_WORKSPACE_TASK_NAME:
            return await handler(request)

        session_id = current_session_id.get()
        tool_call_id = str(request.tool_call.get('id') or '')
        if not session_id:
            return ToolMessage(
                content='Tool error: missing session context',
                tool_call_id=tool_call_id or 'delegate',
                name=name,
            )

        sess = get_session(session_id)
        nested_q = sess.delegate_nested_events_q
        if nested_q is None:
            return ToolMessage(
                content='Tool error: delegate stream not initialized',
                tool_call_id=tool_call_id,
                name=name,
            )

        raw_args = request.tool_call.get('args')
        args: dict[str, Any] = raw_args if isinstance(raw_args, dict) else {}
        task_summary = (args.get('task_summary') or '').strip() or '(empty task summary)'

        done_ev = asyncio.Event()
        sess.delegate_nested_done_event = done_ev
        try:
            try:
                raw_final = await run_nested_worker_delegate_stream(
                    sess, session_id, task_summary, nested_q, self._checkpointer
                )
            except Exception as exc:
                sess.pending_diff_payload = None
                err = f'{type(exc).__name__}: {exc}'
                return ToolMessage(
                    content=f'Tool error: {err}',
                    tool_call_id=tool_call_id,
                    name=name,
                )
            await done_ev.wait()
            return ToolMessage(
                content=_truncate_for_manager(raw_final),
                tool_call_id=tool_call_id,
                name=name,
            )
        finally:
            sess.delegate_nested_done_event = None
