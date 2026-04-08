"""Re-prompt the coding planner when it tries to stop with unfinished checklist work."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Annotated, Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.agents.middleware.types import AgentState, PrivateStateAttr, ResponseT
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT
from typing_extensions import NotRequired, override

logger = logging.getLogger('nemo.agent.langgraph.coding_planner')


class _PlannerTaskRetryState(AgentState[ResponseT]):
    """Tracks consecutive planner reflection nudges (not exposed in I/O schema)."""

    planner_task_retry_streak: NotRequired[Annotated[int, PrivateStateAttr]]


class PlannerTaskRetryMiddleware(AgentMiddleware):
    """Reflect and continue when the planner stops before its checklist is done."""

    state_schema = _PlannerTaskRetryState  # type: ignore[assignment]

    def __init__(
        self,
        *,
        should_retry: Callable[[], bool],
        build_retry_prompt: Callable[[int], str],
        max_retries: int,
    ) -> None:
        self._should_retry = should_retry
        self._build_retry_prompt = build_retry_prompt
        self._max_retries = max(0, int(max_retries))

    @hook_config(can_jump_to=['model'])
    @override
    async def aafter_model(
        self,
        state: _PlannerTaskRetryState,
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        msgs = state.get('messages') or []
        if not msgs:
            return None
        last = msgs[-1]
        if not isinstance(last, AIMessage):
            return None
        if last.tool_calls or getattr(last, 'invalid_tool_calls', None):
            return {'planner_task_retry_streak': 0}
        wants_retry = self._max_retries > 0 and self._should_retry()
        if not wants_retry:
            return {'planner_task_retry_streak': 0}

        streak = int(state.get('planner_task_retry_streak') or 0)
        if streak >= self._max_retries:
            return None

        prompt = self._build_retry_prompt(streak + 1).strip()
        if not prompt:
            return {'planner_task_retry_streak': 0}

        logger.info(
            'Re-prompting coding planner after unfinished checklist stop (%s/%s reflections)',
            streak + 1,
            self._max_retries,
        )
        return {
            'messages': [HumanMessage(content=prompt)],
            'jump_to': 'model',
            'planner_task_retry_streak': streak + 1,
        }
