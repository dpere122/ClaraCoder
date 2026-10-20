"""Shared human-in-the-loop pause for approval cards (LangGraph worker).

Parallel tool calls can each need an approval card. Every card kind keeps its request in a
single session slot (``pending_accept_command_request``, ``pending_delete_request``, ...), so
tools stage into a per-call scope instead (:func:`stage_hitl_request`), and the review
middlewares show the cards one at a time (:func:`pause_for_tool_review`).

A call that stages a card returns a ``Pending user confirmation`` result right away, so its tool
event ends before the card goes out; the approved work runs later, in the answer handler. That
work is timed (:func:`timed_approved_run`) and sent as the call's final status, so the pill shows
how long the call ran, not how long the card waited.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from clara_coder_backend.session.state import get_session

#: Start of every result a tool returns when it staged an approval card instead of running.
PENDING_APPROVAL_PREFIX = 'Pending user confirmation'

#: ``(tool call key, staged requests by session slot name)`` for the tool call running here.
_tool_call_requests: ContextVar[tuple[str, dict[str, Any]] | None] = ContextVar(
    'clara_hitl_tool_call_requests', default=None
)


def tool_call_key(tool_call: dict[str, Any]) -> str:
    """Stable per-call key shared by every review middleware wrapping the same call."""

    return str(tool_call.get('id') or '') or f'object:{id(tool_call)}'


@contextmanager
def hitl_tool_call_scope(key: str) -> Iterator[dict[str, Any]]:
    """Collect the approval requests the wrapped tool call stages.

    Review middlewares around the same call share one scope; parallel calls (and tool calls of
    nested tool calls inside a call) each get their own, so a request is never overwritten by
    another call's before its card is shown.
    """

    current = _tool_call_requests.get()
    if current is not None and current[0] == key:
        yield current[1]
        return
    staged: dict[str, Any] = {}
    token = _tool_call_requests.set((key, staged))
    try:
        yield staged
    finally:
        _tool_call_requests.reset(token)


def stage_hitl_request(session: Any, slot: str, request: Any) -> None:
    """Stage an approval request (``slot`` is the session field the card reads).

    Inside a review middleware the request is held for this tool call, and the middleware puts
    it in the session slot when its card is shown. Outside one (tests, direct calls) it goes
    straight to the session slot.
    """

    current = _tool_call_requests.get()
    if current is None:
        setattr(session, slot, request)
    else:
        current[1][slot] = request


@contextmanager
def timed_approved_run(session: Any | None) -> Iterator[None]:
    """Time the work an approval answer runs; :func:`pause_for_tool_review` reports it.

    Wrap only the work itself (the command, fetch, MCP call or delete), not the card or any
    further prompt such as UAC, so the call's duration is its run time. No-op without a session.
    """

    started = time.monotonic()
    try:
        yield
    finally:
        if session is not None:
            session.agent_pause_run_ms = round((time.monotonic() - started) * 1000)


async def pause_for_tool_review(
    session_id: str,
    item: tuple[Any, ...],
    slots: dict[str, Any],
    *,
    tool_call_id: str = '',
) -> str:
    """Show one tool call's review card and wait for the answer; returns the resume note.

    The lock covers putting the request in its session slots, emitting the card, and waiting.
    Parallel calls queue here, so each card shows its own call's request and each answer
    resumes the call that asked.

    With ``tool_call_id``, the answer is also sent as that call's final status: the note (the
    approved work's result, or the cancel note) and how long the approved work ran.
    """

    sess = get_session(session_id)
    async with sess.hitl_pause_lock:
        for slot, value in slots.items():
            setattr(sess, slot, value)
        # Created before the card goes out, so an immediate answer always finds it.
        event = asyncio.Event()
        sess.agent_pause_event = event
        sess.agent_pause_run_ms = None
        try:
            if sess.hitl_sse_queue is not None:
                await sess.hitl_sse_queue.put(item)
            await event.wait()
        finally:
            sess.agent_pause_event = None
        note = (sess.agent_pause_note or '').strip()
        run_ms = sess.agent_pause_run_ms
        sess.agent_pause_note = None
        sess.agent_pause_run_ms = None
        if tool_call_id and note and sess.hitl_sse_queue is not None:
            await sess.hitl_sse_queue.put(
                ('tool_resolved', {'tool_call_id': tool_call_id, 'text': note, 'duration_ms': run_ms})
            )
        return note


async def await_diff_review_note(session_id: str) -> str:
    """Block until ``POST /chat/agent-continue``; return the optional user note (may be empty)."""
    sess = get_session(session_id)
    async with sess.hitl_pause_lock:
        sess.agent_pause_event = asyncio.Event()
        try:
            await sess.agent_pause_event.wait()
        finally:
            sess.agent_pause_event = None
        note = (sess.agent_pause_note or '').strip()
        sess.agent_pause_note = None
        return note


async def await_question_answers(session_id: str) -> list[dict[str, Any]]:
    """Block until ``POST /chat/agent-question-answers``; return structured answers (may be empty)."""
    sess = get_session(session_id)
    async with sess.hitl_pause_lock:
        sess.agent_pause_event = asyncio.Event()
        try:
            await sess.agent_pause_event.wait()
        finally:
            sess.agent_pause_event = None
        answers: list[dict[str, Any]] = list(sess.question_answers or [])
        return answers
