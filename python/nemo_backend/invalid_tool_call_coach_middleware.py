"""Nudge the model after malformed structured tool calls (``invalid_tool_calls`` on ``AIMessage``).

Runs **after** :class:`~nemo_backend.empty_response_middleware.EmptyResponseNudgeMiddleware` so empty
text without invalid calls is handled first. Caps injected ``HumanMessage`` nudges per thread via
:data:`~nemo_backend.config.MAX_INVALID_TOOL_CALL_COACH_NUDGES`.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.agents.middleware.types import AgentState, PrivateStateAttr, ResponseT
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT
from typing_extensions import NotRequired, override

from nemo_backend.config import MAX_INVALID_TOOL_CALL_COACH_NUDGES
from nemo_backend.model_tuning import effective_parallel_tool_calls
from nemo_backend.state import get_active_connection

logger = logging.getLogger('nemo.agent.langgraph')


def _format_invalid_entries(entries: list[Any]) -> str:
    lines: list[str] = []
    for i, entry in enumerate(entries, start=1):
        if isinstance(entry, dict):
            name = entry.get('name') or entry.get('function', {}).get('name') or '(unknown tool)'
            err = entry.get('error') or entry.get('message') or entry.get('validation_error')
            bit = f'{i}. Tool `{name}`'
            if err:
                bit += f': {err}'
            lines.append(bit)
        else:
            lines.append(f'{i}. {entry!r}')
    return '\n'.join(lines)


class _InvalidToolCallCoachState(AgentState[ResponseT]):
    invalid_tool_call_coach_streak: NotRequired[Annotated[int, PrivateStateAttr]]


class InvalidToolCallCoachMiddleware(AgentMiddleware):
    """Append a coaching HumanMessage and jump back to the model when the last turn had invalid tool calls."""

    state_schema = _InvalidToolCallCoachState  # type: ignore[assignment]

    @hook_config(can_jump_to=['model'])
    @override
    async def aafter_model(
        self,
        state: _InvalidToolCallCoachState,
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        del runtime
        msgs = state.get('messages') or []
        if not msgs:
            return None
        last = msgs[-1]
        if not isinstance(last, AIMessage):
            return None
        inv = getattr(last, 'invalid_tool_calls', None) or ()
        if not inv:
            return {'invalid_tool_call_coach_streak': 0}
        if last.tool_calls:
            # Valid structured calls present; let the tool node run.
            return {'invalid_tool_call_coach_streak': 0}
        streak = int(state.get('invalid_tool_call_coach_streak') or 0)
        if streak >= MAX_INVALID_TOOL_CALL_COACH_NUDGES:
            logger.info(
                'Invalid tool-call coach cap reached (%s/%s); not nudging further',
                streak,
                MAX_INVALID_TOOL_CALL_COACH_NUDGES,
            )
            return None
        conn = get_active_connection()
        parallel_hint = ''
        if not effective_parallel_tool_calls(conn):
            parallel_hint = (
                'Parallel tool calls are disabled for this connection—send **at most one** structured '
                'tool call per assistant turn.\n'
            )
        detail = _format_invalid_entries(list(inv))
        body = (
            'The runtime rejected your last structured tool call(s) as malformed or invalid.\n'
            f'{parallel_hint}'
            'Use an **exact** tool name from the bound tool schema and **valid JSON** for arguments '
            '(types and required fields must match). Do not put tool calls, arguments, or '
            '<tool_call>-style XML in plain assistant text.\n\n'
            f'Details:\n{detail}'
        )
        logger.info(
            'Nudging after invalid_tool_calls (langgraph) (%s/%s)',
            streak + 1,
            MAX_INVALID_TOOL_CALL_COACH_NUDGES,
        )
        return {
            'messages': [HumanMessage(content=body)],
            'jump_to': 'model',
            'invalid_tool_call_coach_streak': streak + 1,
        }
