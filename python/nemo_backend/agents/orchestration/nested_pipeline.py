"""Single LangGraph router graph: handoff tools run specialist ``create_agent`` subgraphs (streaming to nested queue)."""

from __future__ import annotations

import logging
import uuid
from contextlib import contextmanager
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from nemo_backend.agents.specialists.prompts import (
    build_code_review_specialist_system_prompt,
    build_create_specialist_system_prompt,
    build_delete_specialist_system_prompt,
    build_router_system_prompt,
    build_update_specialist_system_prompt,
)
from nemo_backend.agents.specialists.review_tools import code_review_specialist_tools
from nemo_backend.agents.specialists.tools import (
    create_specialist_tools,
    delete_specialist_tools,
    update_specialist_tools,
)
from nemo_backend.config import MAX_AGENT_STEPS
from nemo_backend.delete_review_middleware import DeleteReviewAfterToolMiddleware
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.empty_response_middleware import EmptyResponseNudgeMiddleware
from nemo_backend.domain import SessionState
from nemo_backend.edit_staging import clear_session_staging_dir, discard_all_session_stagings
from nemo_backend.llm import build_llm
from nemo_backend.messages import final_assistant_text
from nemo_backend.parallel_tool_middleware import ConnectionParallelToolCallsMiddleware
from nemo_backend.state import runtime_config

logger = logging.getLogger('nemo.agent.langgraph.planning')

NESTED_WORKER_STREAM_END = object()


@contextmanager
def _suppress_parent_graph_model_token_sse(session: SessionState):
    """Hide nested subgraph LLM tokens on the parent graph's ``astream_events`` queue (see ``SessionState``)."""
    session.suppress_parent_graph_model_token_sse = True
    try:
        yield
    finally:
        session.suppress_parent_graph_model_token_sse = False


async def _enqueue_nested_event(nested_q: Any, stream_tag: str, ev: dict[str, Any]) -> None:
    await nested_q.put((stream_tag, ev))


async def run_planning_nested_stream(
    session: SessionState,
    session_id: str,
    task_summary: str,
    nested_q: Any,
    checkpointer: Any,
) -> str:
    """Run nested planning router; enqueue LangGraph v2 events, then ``NESTED_WORKER_STREAM_END``."""
    last_final_text = ''
    edit_strict = runtime_config.tools.edit_tools_strict
    try:
        llm = build_llm()
    except Exception:
        await nested_q.put(NESTED_WORKER_STREAM_END)
        raise

    with _suppress_parent_graph_model_token_sse(session):
        async def _run_specialist_graph(kind: str, task_instruction: str) -> str:
            spec_llm = build_llm()
            if kind == 'create':
                tools, _ = create_specialist_tools()
                system_prompt = build_create_specialist_system_prompt(session)
            elif kind == 'update':
                tools, _ = update_specialist_tools(edit_strict)
                system_prompt = build_update_specialist_system_prompt(session)
            elif kind == 'delete':
                tools, _ = delete_specialist_tools()
                system_prompt = build_delete_specialist_system_prompt(session)
            elif kind == 'code_review':
                tools, _ = code_review_specialist_tools()
                system_prompt = build_code_review_specialist_system_prompt(session)
            else:
                return f'Unknown specialist kind: {kind}'

            sub = create_agent(
                spec_llm,
                tools,
                system_prompt=system_prompt,
                name=f'nemo_specialist_{kind}',
                middleware=[
                    ConnectionParallelToolCallsMiddleware(),
                    EmptyResponseNudgeMiddleware(),
                    DiffReviewAfterToolMiddleware(),
                    DeleteReviewAfterToolMiddleware(),
                ],
                checkpointer=checkpointer,
            )
            thread_id = f'{session_id}:spec:{kind}:{uuid.uuid4().hex[:10]}'
            config: RunnableConfig = {
                'configurable': {'thread_id': thread_id},
                'recursion_limit': MAX_AGENT_STEPS,
            }
            inputs: dict[str, Any] = {'messages': [HumanMessage(content=task_instruction.strip() or '(no instruction)')]}
            spec_final = ''
            spec_tag = f'spec-{kind}-{uuid.uuid4().hex[:8]}'
            try:
                async for ev in sub.astream_events(inputs, config, version='v2'):
                    await _enqueue_nested_event(nested_q, spec_tag, ev)
                    et = ev.get('event')
                    data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
                    if et == 'on_chat_model_end':
                        raw = data.get('output')
                        msg = raw if isinstance(raw, AIMessage) else None
                        if msg is not None and not (msg.tool_calls or []):
                            spec_final = final_assistant_text(msg)
            except Exception:
                logger.exception('Specialist graph failed (%s)', kind)
                raise
            return spec_final.strip() or f'Specialist `{kind}` finished without a final text response.'

        @tool
        async def route_create_specialist(task_instruction: str) -> str:
            """Hand off new files or full-file writes to the create specialist."""
            return await _run_specialist_graph('create', task_instruction)

        @tool
        async def route_update_specialist(task_instruction: str) -> str:
            """Hand off partial edits (line range / snippet) to the update specialist."""
            return await _run_specialist_graph('update', task_instruction)

        @tool
        async def route_delete_specialist(task_instruction: str) -> str:
            """Hand off file or directory deletion to the delete specialist."""
            return await _run_specialist_graph('delete', task_instruction)

        @tool
        async def route_code_review_specialist(task_instruction: str) -> str:
            """Hand off staged code edits to the code review specialist (read/search staging, approve or reject)."""
            return await _run_specialist_graph('code_review', task_instruction)

        router_tools: list[Any] = [
            route_create_specialist,
            route_update_specialist,
            route_delete_specialist,
            route_code_review_specialist,
        ]

        system_prompt = build_router_system_prompt(session)
        graph = create_agent(
            llm,
            router_tools,
            system_prompt=system_prompt,
            name='nemo_planning_router',
            middleware=[
                ConnectionParallelToolCallsMiddleware(),
                EmptyResponseNudgeMiddleware(),
                DiffReviewAfterToolMiddleware(),
                DeleteReviewAfterToolMiddleware(),
            ],
            checkpointer=checkpointer,
        )
        thread_id = f'{session_id}:planning:{uuid.uuid4().hex[:10]}'
        config: RunnableConfig = {
            'configurable': {'thread_id': thread_id},
            'recursion_limit': MAX_AGENT_STEPS,
        }
        inputs: dict[str, Any] = {'messages': [HumanMessage(content=f'Task:\n{task_summary.strip()}')]}
        try:
            async for ev in graph.astream_events(inputs, config, version='v2'):
                await _enqueue_nested_event(nested_q, 'planning', ev)
                et = ev.get('event')
                data = ev.get('data') if isinstance(ev.get('data'), dict) else {}
                if et == 'on_chat_model_end':
                    raw = data.get('output')
                    msg = raw if isinstance(raw, AIMessage) else None
                    if msg is not None and not (msg.tool_calls or []):
                        last_final_text = final_assistant_text(msg)
        except Exception:
            logger.exception('Planning nested graph failed')
            raise
        finally:
            if session.pending_edit_stagings:
                logger.warning(
                    'Orphaned nested edit stagings after planning (discarding): %s',
                    list(session.pending_edit_stagings.keys()),
                )
                discard_all_session_stagings(session)
            clear_session_staging_dir(session_id)
            await nested_q.put(NESTED_WORKER_STREAM_END)

        if not last_final_text.strip():
            last_final_text = (
                'The nested workspace agent finished without a final text response. '
                'Try rephrasing the task.'
            )
        return last_final_text
