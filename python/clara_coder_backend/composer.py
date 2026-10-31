"""SSE streaming agent entry point (LangGraph).

This module is the thin orchestrator above the graph runners:

1. ``POST /chat/stream`` (``routes.chat``) calls :func:`stream_agent_reply`.
2. This function resets session turn state, validates LLM config, then dispatches:
   - ``composer_mode == 'plan'`` → :func:`stream_plan_execute_langgraph`
   - otherwise → :func:`stream_single_agent_langgraph` (``lang_agent.graph``)
3. It relays SSE lines to the Electron renderer, then handles post-stream chores
   (checkpoint compact / cleanup, in-memory history commit, checkpoint sync record for ``/load``,
   ``final_text``, ``[DONE]``).

HITL pauses (diff / copy / delete / accept-command review) happen *inside* the graph
runners via middleware. While paused, this generator simply does not yield until the
graph unblocks after ``POST /chat/agent-continue``. Abort is cooperative: the UI sets
``session.abort_event`` and this loop breaks on the next yielded line.

A stopped agent-mode turn keeps its checkpoint and is committed to history with an
``[Interrupted by the user]`` marker; the next turn gets a note with what was cut off.
Sub-agents (:mod:`~clara_coder_backend.lang_agent.subagents`) call this directly for their
one-shot turn and skip that bookkeeping.

A main session's turn counts as live for its sub-agents' reports while it runs; when it ends with
reports still waiting (and no other turn queued), ``subagent_results_ready`` goes out so Electron can
continue with them (``continue_with_subagent_results``).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any

from fastapi import HTTPException

from clara_coder_backend.lang_agent.graph import stream_single_agent_langgraph
from clara_coder_backend.plan.plan_execute import stream_plan_execute_langgraph, PLAN_EXECUTE_APPLY_MODE
from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, DEFAULT_AGENT_LOOP_POLICY, LangGraphWorkerOutcome
from clara_coder_backend.session.checkpointing import (
    delete_outer_thread,
    delete_outer_threads_for_session,
    forget_outer_thread_sync,
    settle_outer_thread,
)
from clara_coder_backend.lang_agent.context_compression import maybe_compact_outer_checkpoint
from clara_coder_backend.lang_agent.streaming import model_chunk_sse_line, sse_line, status_event
from clara_coder_backend.config import MAX_TOOL_STATUS_LINE
from clara_coder_backend.domain import SessionState
from clara_coder_backend.llm.factory import build_llm
from clara_coder_backend.logging.llm_interaction_logging import log_llm_user_request
from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.session.state import current_session_id, get_session, touch_session
from clara_coder_backend.session.user_events import INTERRUPTED_TURN_MARKER, queue_interrupted_turn_note
from clara_coder_backend.lang_agent.subagents import (
    CONTINUE_WITH_REPORTS_TEXT,
    NO_NEW_REPORTS_TEXT,
    SubagentReport,
    drain_subagent_reports,
    format_subagent_reports,
    maybe_publish_results_ready,
    requeue_subagent_reports,
)
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
    tts_provider: str = 'kokoro',
    user_message_id: str = '',
    admin_elevation_granted: bool = False,
    workspace_notes: list[str] | None = None,
    outcome_sink: LangGraphWorkerOutcome | None = None,
    continue_with_subagent_results: bool = False,
) -> AsyncIterator[str]:
    """Run one user turn and yield SSE lines until ``data: [DONE]``.

    Parameters
    ----------
    session_id:
        In-memory session key (Electron conversation id).
    user_message:
        Plain text, or structured multimodal content blocks from the chat composer.
    apply_mode:
        Editor tools (write-through edits, commands) enabled when true (read-only tools when false).
    auto_apply_mode:
        Auto Run: when true, command / web / MCP tools skip their approval card. Edits never pause.
    admin_elevation_granted:
        Re-applies the conversation Admin chip so ``/load`` or a new session
        object cannot silently drop the agent’s elevated-command grant.
    resume_checkpoint_id:
        Optional LangGraph checkpoint to resume (single-agent mode only).
    composer_mode:
        ``'agent'`` (default ReAct) or ``'plan'`` (plan-and-execute pipeline).
    speech_enabled:
        Stored on the session for TTS-aware UI; does not change graph topology here.
    tts_provider:
        TTS backend for this turn (``kokoro`` or ``openai-compatible``); mood-tag prompt is OpenAI-only.
    workspace_notes:
        Facts from the UI since the last turn (e.g. files the user reset); injected before the first model call.
    outcome_sink:
        Filled with the turn's outcome on every exit path (a sub-agent's caller reads its report from it).
    continue_with_subagent_results:
        Ignore ``user_message``: this turn's input is the sub-agent reports waiting on the session (or a
        short "nothing new" line), and history records that text as the user message.
    """
    session = get_session(session_id)
    touch_session(session)

    # --- Turn bootstrap: clear leftover HITL / plan state from a prior stream ---
    session.agent_pause_event = None
    session.agent_pause_note = None
    session.agent_pause_run_ms = None
    session.pending_plan_confirm_request = None
    session.plan_execute_aborted = False
    session.auto_apply_mode = auto_apply_mode
    if session.admin_elevation_granted and not admin_elevation_granted:
        # The UI says Admin is off: do not leave a live elevated helper behind.
        from clara_coder_backend.runtime.admin_exec import shutdown_session_broker

        await shutdown_session_broker(session_id)
    session.admin_elevation_granted = bool(admin_elevation_granted)
    # Remember stream flags for tools/UI that read them after this generator returns.
    session.last_stream_apply_mode = apply_mode
    session.last_stream_auto_apply_mode = auto_apply_mode
    session.last_stream_speech_enabled = bool(speech_enabled)
    session.last_stream_tts_provider = (
        'openai-compatible' if tts_provider == 'openai-compatible' else 'kokoro'
    )
    session.current_user_message_id = (user_message_id or '').strip()
    session.pending_user_event_notes.extend(n.strip() for n in workspace_notes or [] if n and n.strip())
    is_subagent = bool(session.subagent_parent_session_id)
    # Reports this turn took as its input (the turn also tracks the ones it takes later).
    continue_reports: list[SubagentReport] = []
    if continue_with_subagent_results and not is_subagent:
        continue_reports = drain_subagent_reports(session)
        user_message = (
            format_subagent_reports(continue_reports, closing=CONTINUE_WITH_REPORTS_TEXT)
            if continue_reports
            else NO_NEW_REPORTS_TEXT
        )

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
    # Shared outcome bag: graph runners mutate this; we use it after the stream ends.
    graph_outcome = outcome_sink if outcome_sink is not None else LangGraphWorkerOutcome()
    if not is_subagent:
        # Sub-agent reports queued from now on go to this turn instead of ``subagent_results_ready``.
        session.subagent_live_turns += 1
        # Every report this turn takes; put back if its thread is dropped, so none is lost.
        session.subagent_turn_reports = list(continue_reports)

    try:
        # Fail fast with a user-visible SSE error if no LLM connection is configured.
        try:
            build_llm()
        except HTTPException as exc:
            graph_outcome.mark_failed_configuration(str(exc.detail), final_text=str(exc.detail))
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

        mode = (composer_mode or 'agent').strip().lower()
        if not is_subagent:
            try:
                # Until this turn settles, ``/load`` must not keep a thread on its old sync row.
                await forget_outer_thread_sync(session_id)
            except Exception:
                logger.warning('clearing the outer checkpoint sync failed session=%s', session_id, exc_info=True)
        stream_fn =stream_plan_execute_langgraph if mode == 'plan' else stream_single_agent_langgraph
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
        # ``aclosing`` runs the runner's cleanup (pump stop, stream counters) before the post-stream
        # chores below, not later from the event loop's async-generator hooks.
        async with aclosing(stream_fn(**stream_kwargs)) as graph_lines:
            async for line in graph_lines:
                # Once the runner has seen the abort itself it is winding down in order (e.g. settling
                # its sub-agent waiting pill); only a still-running stream is cut here.
                if session.abort_event.is_set() and graph_outcome.state == AgentLoopOutcome.RUNNING:
                    graph_outcome.mark_aborted(partial_text=graph_outcome.partial_text)
                    logger.info('Stream aborted for session %s', session_id)
                    break
                yield line

        # --- Post-stream: compact / drop checkpoints based on outcome ---
        compact_freed = 0
        if (
            graph_outcome.state == AgentLoopOutcome.COMPLETED
            and mode != 'plan'
            and session.active_langgraph_agent_streams == 0
            and not is_subagent
        ):
            # Shrink outer checkpoint when the single-agent turn finished cleanly.
            compact_stats = await maybe_compact_outer_checkpoint(session_id, apply_mode, session)
            if compact_stats is not None and compact_stats.changed:
                compact_freed = max(0, compact_stats.tokens_before - compact_stats.tokens_after)
                yield sse_line(compact_stats.to_sse_payload())

        # A stopped agent turn keeps its thread: the next turn repairs its open tool calls instead.
        kept_interrupted = graph_outcome.state == AgentLoopOutcome.ABORTED and mode != 'plan'
        if graph_outcome.state != AgentLoopOutcome.COMPLETED and not kept_interrupted:
            # Failed turns (and stopped plan turns) leave a partial thread; delete so the next turn starts clean.
            thread_kind = 'plan' if mode == 'plan' else 'single'
            ck_apply = PLAN_EXECUTE_APPLY_MODE if mode == 'plan' else apply_mode
            await delete_outer_thread(session_id, thread_kind, apply_mode=ck_apply)
            # No thread left to repair: results stashed for its open spawn calls must not linger.
            session.subagent_interrupted_reports.clear()

        # Persist this turn in the in-memory session history (Electron may also mirror to SQLite).
        # Sub-agents are one-shot: their report goes back to the parent, not into a history.
        if is_subagent:
            pass
        elif kept_interrupted:
            _commit_interrupted_turn(session, user_message, graph_outcome)
        elif DEFAULT_AGENT_LOOP_POLICY.should_commit_history(graph_outcome):
            session.history.append({'role': 'user', 'content': user_message})
            session.history.append({'role': 'assistant', 'content': graph_outcome.best_available_text()})

        if not is_subagent and session.active_langgraph_agent_streams == 0:
            try:
                if mode == 'plan':
                    # Plan turns run on their own threads: the agent's threads no longer cover history.
                    await delete_outer_threads_for_session(session_id, 'single')
                elif graph_outcome.state == AgentLoopOutcome.COMPLETED or kept_interrupted:
                    # The thread now covers this turn: record that for ``/load``, prune it.
                    await settle_outer_thread(
                        session_id,
                        apply_mode=apply_mode,
                        history=session.history,
                        freed_tokens=compact_freed,
                    )
                else:
                    # This thread is gone; the other Editor mode's one does not have this turn either.
                    await delete_outer_thread(session_id, 'single', apply_mode=not apply_mode)
            except Exception:
                logger.warning('settling the outer checkpoint failed session=%s', session_id, exc_info=True)

        # Clean final assistant text for the UI (distinct from streamed token chunks).
        final_text = graph_outcome.final_text.strip()
        if final_text:
            yield sse_line({'type': 'final_text', 'text': final_text})

        yield 'data: [DONE]\n\n'
    except Exception as exc:
        # Unexpected failure: drop the checkpoint thread and surface a fatal SSE status.
        graph_outcome.mark_failed_runtime(
            f'{type(exc).__name__}: {exc}',
            final_text='Error: the LangChain backend failed while generating a response.',
            partial_text=graph_outcome.partial_text,
        )
        try:
            thread_kind = 'plan' if (composer_mode or 'agent').strip().lower() == 'plan' else 'single'
            ck_apply = PLAN_EXECUTE_APPLY_MODE if thread_kind == 'plan' else apply_mode
            await delete_outer_thread(session_id, thread_kind, apply_mode=ck_apply)
            if thread_kind == 'single' and not is_subagent:
                await delete_outer_thread(session_id, 'single', apply_mode=not apply_mode)
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
        if graph_outcome.state == AgentLoopOutcome.RUNNING:
            # Closed or cancelled before the runner settled (e.g. a sub-agent hard-stopped).
            graph_outcome.mark_aborted(partial_text=graph_outcome.partial_text)
        current_session_id.reset(token)
        if not is_subagent:
            plan_mode = (composer_mode or 'agent').strip().lower() == 'plan'
            _end_parent_turn(session_id, session, graph_outcome, plan_mode=plan_mode)


def _end_parent_turn(
    session_id: str,
    session: SessionState,
    outcome: LangGraphWorkerOutcome,
    *,
    plan_mode: bool,
) -> None:
    """A main session's turn ended: reports still waiting go out as ``subagent_results_ready``.

    A turn whose thread was dropped (it failed, or a plan turn stopped) puts back the reports it took:
    neither its checkpoint nor history keeps them. A failed turn does not notify (the next turn gets
    them; a fresh notification would only start another turn that fails the same way).
    """
    session.subagent_live_turns = max(0, session.subagent_live_turns - 1)
    taken, session.subagent_turn_reports = session.subagent_turn_reports, []
    failed = outcome.state in (AgentLoopOutcome.FAILED_CONFIGURATION, AgentLoopOutcome.FAILED_RUNTIME)
    dropped = failed or (outcome.state == AgentLoopOutcome.ABORTED and plan_mode)
    if taken and dropped:
        requeue_subagent_reports(session, taken)
        if failed:
            return
    try:
        maybe_publish_results_ready(session_id, ending_turn=True)
    except Exception:
        logger.warning('sub-agent results notification failed session=%s', session_id, exc_info=True)


def _commit_interrupted_turn(
    session: SessionState,
    user_message: str | list[dict[str, Any]],
    outcome: LangGraphWorkerOutcome,
) -> None:
    """Keep a stopped agent turn: history gets the partial reply with a marker, the next turn a note.

    The checkpoint stays too, so the model sees its finished steps; the note carries what no
    checkpoint holds (the text of a step cut off mid-stream). A card still waiting when the turn
    stopped can no longer be answered, so its slot is cleared.
    """
    partial = outcome.partial_text.strip()
    session.history.append({'role': 'user', 'content': user_message})
    session.history.append(
        {'role': 'assistant', 'content': f'{partial}\n\n{INTERRUPTED_TURN_MARKER}' if partial else INTERRUPTED_TURN_MARKER}
    )
    queue_interrupted_turn_note(session, user_message, outcome.uncommitted_text)
    session.pending_accept_command_request = None
    session.pending_delete_request = None


__all__ = ['stream_agent_reply']
