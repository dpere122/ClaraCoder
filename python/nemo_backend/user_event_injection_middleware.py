"""Inject queued user/system event notes before each model call."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage

from nemo_backend.state import current_session_id, get_session
from nemo_backend.user_events import drain_user_event_notes


class UserEventInjectionMiddleware(AgentMiddleware):
    """Prepend drained ``pending_user_event_notes`` as HumanMessages before each model call."""

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
        merged = list(request.messages) + extra
        return await handler(request.override(messages=merged))
