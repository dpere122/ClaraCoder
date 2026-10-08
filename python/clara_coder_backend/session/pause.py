"""Shared human-in-the-loop pause for diff review (classic loop + LangGraph worker).

Parallel tool calls can each need an approval card. Every card kind keeps its request in a
single session slot (``pending_accept_command_request``, ``pending_delete_request``, ...), so
tools stage into a per-call scope instead (:func:`stage_hitl_request`), and the review
middlewares show the cards one at a time (:func:`pause_for_tool_review`).
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from clara_coder_backend.session.state import get_session

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
    nested specialists inside a call) each get their own, so a request is never overwritten by
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


async def pause_for_tool_review(session_id: str, item: tuple[Any, ...], slots: dict[str, Any]) -> str:
    """Show one tool call's review card and wait for the answer; returns the resume note.

    The lock covers putting the request in its session slots, emitting the card, and waiting.
    Parallel calls queue here, so each card shows its own call's request and each answer
    resumes the call that asked.
    """

    sess = get_session(session_id)
    async with sess.hitl_pause_lock:
        for slot, value in slots.items():
            setattr(sess, slot, value)
        # Created before the card goes out, so an immediate answer always finds it.
        event = asyncio.Event()
        sess.agent_pause_event = event
        try:
            if sess.hitl_sse_queue is not None:
                await sess.hitl_sse_queue.put(item)
            await event.wait()
        finally:
            sess.agent_pause_event = None
        note = (sess.agent_pause_note or '').strip()
        sess.agent_pause_note = None
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
