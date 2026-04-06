"""SSE streaming agent entry point (LangGraph).

Yields Server-Sent Events lines consumed by the Electron renderer. Status events report
tool progress and optional ``agent_role`` for UI labels.

When :attr:`~nemo_backend.domain.SessionState.auto_apply_mode` is false and a tool in
:func:`nemo_backend.tool_registry.hitl_diff_pause_tools` or
:func:`nemo_backend.tool_registry.hitl_delete_pause_tools` requires review, the HTTP stream
pauses until ``POST /chat/agent-continue``. LangGraph agents use diff/delete middleware and
the same pause API.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from fastapi import HTTPException

from nemo_backend.agent_langgraph import LangGraphWorkerOutcome, stream_single_agent_langgraph
from nemo_backend.agent_streaming import model_chunk_sse_line, sse_line, status_event
from nemo_backend.config import MAX_TOOL_STATUS_LINE
from nemo_backend.llm import build_llm
from nemo_backend.llm_interaction_logging import log_llm_user_request
from nemo_backend.state import current_session_id, get_session
from nemo_backend.workspace_tools import truncate_text

logger = logging.getLogger('nemo.agent')


async def stream_agent_reply(
    session_id: str,
    user_message: str,
    apply_mode: bool = True,
    auto_apply_mode: bool = False,
) -> AsyncIterator[str]:
    """Run the tool-capable agent and yield SSE lines until [DONE]."""
    session = get_session(session_id)
    session.agent_pause_event = None
    session.agent_pause_note = None
    session.auto_apply_mode = auto_apply_mode

    token = current_session_id.set(session_id)

    log_llm_user_request(
        user_message,
        session_id=session_id,
        apply_mode=apply_mode,
        auto_apply_mode=auto_apply_mode,
    )

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
        async for line in stream_single_agent_langgraph(
            session,
            user_message,
            apply_mode,
            session_id=session_id,
            outcome=graph_outcome,
        ):
            yield line
        final_text = graph_outcome.final_text

        session.history.append({'role': 'user', 'content': user_message})
        session.history.append({'role': 'assistant', 'content': final_text})

        yield 'data: [DONE]\n\n'
    except Exception as exc:
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
