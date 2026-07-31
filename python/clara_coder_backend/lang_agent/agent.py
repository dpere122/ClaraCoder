"""SSE streaming agent entry point (LangGraph).

This module is the thin orchestrator above the graph runners:

1. ``POST /chat/stream`` (``routes.chat``) calls :func:`stream_agent_reply`.
2. This function resets session turn state, validates LLM config, then dispatches:
   - ``composer_mode == 'plan'`` → :func:`stream_plan_execute_langgraph`
   - otherwise → :func:`stream_single_agent_langgraph` (``lang_agent.graph``)
3. It relays SSE lines to the Electron renderer, then handles post-stream chores
   (checkpoint compact / cleanup, in-memory history commit, ``final_text``, ``[DONE]``).

HITL pauses (diff / copy / delete / accept-command review) happen *inside* the graph
runners via middleware. While paused, this generator simply does not yield until the
graph unblocks after ``POST /chat/agent-continue``. Abort is cooperative: the UI sets
``session.abort_event`` and this loop breaks on the next yielded line.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import HTTPException

from clara_coder_backend.lang_agent.graph import stream_single_agent_langgraph
from clara_coder_backend.plan_execute import stream_plan_execute_langgraph, PLAN_EXECUTE_APPLY_MODE
from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, DEFAULT_AGENT_LOOP_POLICY, LangGraphWorkerOutcome
from clara_coder_backend.checkpointing import delete_outer_thread
from clara_coder_backend.context_compression import maybe_compact_outer_checkpoint
from clara_coder_backend.lang_agent.streaming import model_chunk_sse_line, sse_line, status_event
from clara_coder_backend.config import MAX_TOOL_STATUS_LINE
from clara_coder_backend.llm import build_llm
from clara_coder_backend.llm_interaction_logging import log_llm_user_request
from clara_coder_backend.messages import stringify_content
from clara_coder_backend.state import current_session_id, get_session
from clara_coder_backend.tools.workspace import truncate_text

logger = logging.getLogger('clara.agent')


async def stream_agent_reply(
    session_id: str,
    user_message: str | list[dict[str, Any]],
    apply_mode: bool = True,
    auto_apply_mode: bool = False,
    resume_checkpoint_id: str | None = None,
    composer_mode: str = 'agent',
    speech_enabled: bool = False,
) -> AsyncIterator[str]:
    """Run one user turn and yield SSE lines until ``data: [DONE]``.

    Parameters
    ----------
    session_id:
        In-memory session key (Electron conversation id).
    user_message:
        Plain text, or structured multimodal content blocks from the chat composer.
    apply_mode:
        Editor/staging tools enabled when true (read-only tools when false).
    auto_apply_mode:
        When false, HITL middleware pauses after reviewable tool results.
    resume_checkpoint_id:
        Optional LangGraph checkpoint to resume (single-agent mode only).
    composer_mode:
        ``'agent'`` (default ReAct) or ``'plan'`` (plan-and-execute pipeline).
    speech_enabled:
        Stored on the session for TTS-aware UI; does not change graph topology here.
    """
    session = get_session(session_id)

    # --- Turn bootstrap: clear leftover HITL / plan state from a prior stream ---
    session.agent_pause_event = None
    session.agent_pause_note = None
    session.pending_plan_confirm_request = None
    session.plan_execute_aborted = False
    session.auto_apply_mode = auto_apply_mode
    # Remember stream flags for tools/UI that read them after this generator returns.
    session.last_stream_apply_mode = apply_mode
    session.last_stream_auto_apply_mode = auto_apply_mode
    session.last_stream_speech_enabled = bool(speech_enabled)

    # ContextVar so tools/middleware can resolve the active session without threading ids.
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
        # Fail fast with a user-visible SSE error if no LLM connection is configured.
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

        # Shared outcome bag: graph runners mutate this; we use it after the stream ends.
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
        # Checkpoint resume is a single-agent feature (plan mode uses its own threads).
        if mode != 'plan':
            stream_kwargs['resume_checkpoint_id'] = resume_checkpoint_id

        # --- Relay graph SSE; honor abort between lines ---
        async for line in stream_fn(**stream_kwargs):
            if session.abort_event.is_set():
                if graph_outcome.state == AgentLoopOutcome.RUNNING:
                    graph_outcome.mark_aborted(partial_text=graph_outcome.partial_text)
                logger.info('Stream aborted for session %s', session_id)
                break
            yield line

        # --- Post-stream: compact / drop checkpoints based on outcome ---
        if (
            graph_outcome.state == AgentLoopOutcome.COMPLETED
            and mode != 'plan'
            and session.active_langgraph_agent_streams == 0
        ):
            # Shrink outer checkpoint when the single-agent turn finished cleanly.
            compact_stats = await maybe_compact_outer_checkpoint(session_id, apply_mode, session)
            if compact_stats is not None and compact_stats.changed:
                yield sse_line(compact_stats.to_sse_payload())

        if graph_outcome.state != AgentLoopOutcome.COMPLETED:
            # Incomplete turns leave a partial thread; delete so the next turn starts clean.
            thread_kind = 'plan' if mode == 'plan' else 'single'
            ck_apply = PLAN_EXECUTE_APPLY_MODE if mode == 'plan' else apply_mode
            await delete_outer_thread(session_id, thread_kind, apply_mode=ck_apply)

        # Persist this turn in the in-memory session history (Electron may also mirror to SQLite).
        if DEFAULT_AGENT_LOOP_POLICY.should_commit_history(graph_outcome):
            session.history.append({'role': 'user', 'content': user_message})
            session.history.append({'role': 'assistant', 'content': graph_outcome.best_available_text()})

        # Clean final assistant text for the UI (distinct from streamed token chunks).
        final_text = graph_outcome.final_text.strip()
        if final_text:
            yield sse_line({'type': 'final_text', 'text': final_text})

        yield 'data: [DONE]\n\n'
    except Exception as exc:
        # Unexpected failure: drop the checkpoint thread and surface a fatal SSE status.
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
