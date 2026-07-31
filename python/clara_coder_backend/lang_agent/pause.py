"""Shared human-in-the-loop pause for diff review (classic loop + LangGraph worker)."""

from __future__ import annotations

import asyncio
from typing import Any

from clara_coder_backend.state import get_session


async def await_diff_review_note(session_id: str) -> str:
    """Block until ``POST /chat/agent-continue``; return the optional user note (may be empty)."""
    sess = get_session(session_id)
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
    sess.agent_pause_event = asyncio.Event()
    try:
        await sess.agent_pause_event.wait()
    finally:
        sess.agent_pause_event = None
    answers: list[dict[str, Any]] = list(sess.question_answers or [])
    return answers
