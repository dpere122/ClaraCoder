"""Deliver queued user/system event notes with the next model call, and keep them in the thread."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelResponse
from langchain_core.messages import HumanMessage

from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.session.user_events import drain_user_event_notes


class UserEventInjectionMiddleware(AgentMiddleware):
    """Append drained ``pending_user_event_notes`` as HumanMessages to the next model call and to the thread.

    The notes are saved ahead of the reply they produced, so the next call sends the same history again.
    A note sent once and then left out would change the conversation before that reply, which costs the
    reply's reasoning on providers that check it (Claude's preserved thinking) and the prompt cache everywhere.
    """

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        sid = (current_session_id.get() or '').strip()
        if not sid:
            return await handler(request)
        notes = drain_user_event_notes(get_session(sid))
        if not notes:
            return await handler(request)
        extra = [HumanMessage(content=note) for note in notes]
        response = await handler(request.override(messages=[*request.messages, *extra]))
        return with_messages_before(response, extra)


def with_messages_before(response: ModelResponse, messages: list[Any]) -> ModelResponse:
    """``response`` with ``messages`` saved to the thread ahead of the reply (the order they were sent in)."""
    return ModelResponse(
        result=[*messages, *response.result],
        structured_response=response.structured_response,
    )
