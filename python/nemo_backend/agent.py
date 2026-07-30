"""SSE streaming agent entry point (LangGraph).

Yields Server-Sent Events lines consumed by the Electron renderer. Status events report
tool progress and optional ``agent_role`` for UI labels.

When :attr:`~nemo_backend.domain.SessionState.auto_apply_mode` is false and a tool in
:func:`nemo_backend.tool_registry.hitl_diff_pause_tools`,
:func:`nemo_backend.tool_registry.hitl_copy_pause_tools`, or
:func:`nemo_backend.tool_registry.hitl_delete_pause_tools` requires review, the HTTP stream
pauses until ``POST /chat/agent-continue``. LangGraph agents use diff/copy/delete middleware
and the same pause API.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import HTTPException

from nemo_backend.agent_langgraph import stream_single_agent_langgraph
from nemo_backend.plan_execute import stream_plan_execute_langgraph, PLAN_EXECUTE_APPLY_MODE
from nemo_backend.agent_loop import AgentLoopOutcome, DEFAULT_AGENT_LOOP_POLICY, LangGraphWorkerOutcome
from nemo_backend.checkpointing import delete_outer_thread
from nemo_backend.context_compression import maybe_compact_outer_checkpoint
from nemo_backend.agent_streaming import model_chunk_sse_line, sse_line, status_event
from nemo_backend.config import MAX_TOOL_STATUS_LINE
from nemo_backend.llm import build_llm
from nemo_backend.llm_interaction_logging import log_llm_user_request
from nemo_backend.messages import stringify_content
from nemo_backend.state import current_session_id, get_session
from nemo_backend.tools.workspace import truncate_text

logger = logging.getLogger('nemo.agent')


async def stream_agent_reply(
    session_id: str,
    user_message: str | list[dict[str, Any]],
    apply_mode: bool = True,
    auto_apply_mode: bool = False,
    resume_checkpoint_id: str | None = None,
    composer_mode: str = 'agent',
    speech_enabled: bool = False,
) -> AsyncIterator[str]:
    """Run the tool-capable agent and yield SSE lines until [DONE]."""
    session = get_session(session_id)
    session.agent_pause_event = None
    session.agent_pause_note = None
    session.pending_plan_confirm_request = None
    session.plan_execute_aborted = False
    session.auto_apply_mode = auto_apply_mode
    session.last_stream_apply_mode = apply_mode
    session.last_stream_auto_apply_mode = auto_apply_mode
    session.last_stream_speech_enabled = bool(speech_enabled)

    token = current_session_id.set(session_id)

    _preview = stringify_content(user_message).strip()
    _structured = not isinstance(user_message, str)
    log_llm_user_request(
        _preview or ('(multimodal turn)' if _structured else ''),
        session_id=session_id,
        apply_mode=apply_mode,
        auto_apply_mode=auto_apply_mode,
        structured=_structured,
    )

    session.abort_event.clear()

    try:
        try:
            build_llm()
        except HTTPException as exc:
            yield sse_line(
                status_event(
                    'bootstrap',
                    'Configuration issue',
                    detail=truncate_text(str(exc.detail).replace('\n', ' '), MAX_TOOL_STATUS_LINE),
                    state='error',
                )
            )
            yield model_chunk_sse_line(exc.detail, 'agent')
            yield 'data: [DONE]\n\n'
            return

        graph_outcome = LangGraphWorkerOutcome()
        mode = (composer_mode or 'agent').strip().lower()
        stream_fn = stream_plan_execute_langgraph if mode == 'plan' else stream_single_agent_langgraph
        stream_kwargs: dict[str, Any] = {
            'session': session,
            'user_message': user_message,
            'apply_mode': apply_mode,
            'session_id': session_id,
            'outcome': graph_outcome,
        }
        if mode != 'plan':
            stream_kwargs['resume_checkpoint_id'] = resume_checkpoint_id
        async for line in stream_fn(**stream_kwargs):
            if session.abort_event.is_set():
                if graph_outcome.state == AgentLoopOutcome.RUNNING:
                    graph_outcome.mark_aborted(partial_text=graph_outcome.partial_text)
                logger.info('Stream aborted for session %s', session_id)
                break
            yield line

        if (
            graph_outcome.state == AgentLoopOutcome.COMPLETED
            and mode != 'plan'
            and session.active_langgraph_agent_streams == 0
        ):
            compact_stats = await maybe_compact_outer_checkpoint(session_id, apply_mode, session)
            if compact_stats is not None and compact_stats.changed:
                yield sse_line(compact_stats.to_sse_payload())

        if graph_outcome.state != AgentLoopOutcome.COMPLETED:
            thread_kind = 'plan' if mode == 'plan' else 'single'
            ck_apply = PLAN_EXECUTE_APPLY_MODE if mode == 'plan' else apply_mode
            await delete_outer_thread(session_id, thread_kind, apply_mode=ck_apply)

        if DEFAULT_AGENT_LOOP_POLICY.should_commit_history(graph_outcome):
            session.history.append({'role': 'user', 'content': user_message})
            session.history.append({'role': 'assistant', 'content': graph_outcome.best_available_text()})

        # Send the final text (clean, without intermediate briefs) to the frontend
        final_text = graph_outcome.final_text.strip()
        if final_text:
            yield sse_line({'type': 'final_text', 'text': final_text})

        yield 'data: [DONE]\n\n'
    except Exception as exc:
        try:
            thread_kind = 'plan' if (composer_mode or 'agent').strip().lower() == 'plan' else 'single'
            ck_apply = PLAN_EXECUTE_APPLY_MODE if thread_kind == 'plan' else apply_mode
            await delete_outer_thread(session_id, thread_kind, apply_mode=ck_apply)
        except Exception:
            logger.debug('checkpoint cleanup after agent error failed', exc_info=True)
        yield sse_line(
            status_event(
                'fatal',
                'LangChain request failed',
                detail=f'{type(exc).__name__}: {exc}',
                state='error',
            )
        )
        yield model_chunk_sse_line('Error: the LangChain backend failed while generating a response.', 'agent')
        yield 'data: [DONE]\n\n'
    finally:
        current_session_id.reset(token)


__all__ = ['stream_agent_reply']
