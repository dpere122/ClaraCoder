"""Re-nudge the model when a LangGraph agent turn returns empty text and no tool calls.

``create_agent`` graphs otherwise treat an empty ``AIMessage`` as a finished answer;
this middleware injects a user nudge up to :data:`nemo_backend.config.MAX_AGENT_EMPTY_NUDGES` times.
It also nudges (separate cap, :data:`nemo_backend.config.MAX_AGENT_PSEUDO_TOOL_NUDGES`) when the
model encodes tool usage as ``<tool_call>`` / ``<function=...>`` XML in assistant text or reasoning
but the completion includes no registered ``tool_calls``—a frequent mismatch with some Qwen templates.

The nudge streak counter only resets when the model produces *visible text* (the goal of
the nudge).  Tool calls alone do **not** reset it—this prevents an alternating loop where
the model answers a nudge with tool calls instead of text and then goes empty again, which
would reset the counter and allow the cycle to repeat indefinitely.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain.agents.middleware.types import AgentState, PrivateStateAttr, ResponseT
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT
from typing_extensions import NotRequired, override

from nemo_backend.config import MAX_AGENT_EMPTY_NUDGES, MAX_AGENT_PSEUDO_TOOL_NUDGES
from nemo_backend.messages import final_assistant_text, text_uses_pseudo_tool_markup

logger = logging.getLogger('nemo.agent.langgraph')

_EMPTY_NUDGE_TEXT = (
    'Your last message had no user-visible text. Reply with a clear, complete '
    'answer for the user (plain language; omit tools if not needed).'
)

_EMPTY_NUDGE_TEXT_HAS_TOOL_RESULTS = (
    'Your last message had no user-visible text. You already have tool results '
    'in this conversation—do NOT call tools again. Summarize what you found and '
    'reply with a clear, complete answer for the user in plain language.'
)

_PSEUDO_TOOL_MARKUP_NUDGE_TEXT = (
    'Your last completion did not register any tool calls on the API, but it contained tool usage as '
    '``<tool_call>`` / ``<function=...>`` or ``<parameter=...>`` XML in the assistant or reasoning text. '
    'That form is not executed. Issue the same action again using the model\'s **tool-calling** channel only '
    '(normal function/tool invocations the API accepts), not as raw XML. Keep any prose minimal or empty.'
)


def _has_recent_tool_results(msgs: list[Any]) -> bool:
    """True when the conversation already contains ToolMessage results."""
    return any(isinstance(m, ToolMessage) for m in msgs)


class _EmptyResponseNudgeState(AgentState[ResponseT]):
    """Tracks empty no-tool model turns for nudging (not exposed in I/O schema)."""

    empty_response_nudge_streak: NotRequired[Annotated[int, PrivateStateAttr]]
    pseudo_tool_markup_nudge_streak: NotRequired[Annotated[int, PrivateStateAttr]]


class EmptyResponseNudgeMiddleware(AgentMiddleware):
    """After an empty assistant message with no tools, append a user nudge and call the model again."""

    state_schema = _EmptyResponseNudgeState  # type: ignore[assignment]

    @hook_config(can_jump_to=['model'])
    @override
    async def aafter_model(
        self,
        state: _EmptyResponseNudgeState,
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        msgs = state.get('messages') or []
        if not msgs:
            return None
        last = msgs[-1]
        if not isinstance(last, AIMessage):
            return None
        if last.tool_calls:
            if final_assistant_text(last).strip():
                return {
                    'empty_response_nudge_streak': 0,
                    'pseudo_tool_markup_nudge_streak': 0,
                }
            return {
                'empty_response_nudge_streak': 0,
                'pseudo_tool_markup_nudge_streak': 0,
            }
        inv = getattr(last, 'invalid_tool_calls', None) or ()
        if inv:
            return None
        fat = (final_assistant_text(last) or '').strip()
        if text_uses_pseudo_tool_markup(fat) and MAX_AGENT_PSEUDO_TOOL_NUDGES > 0:
            p_streak = int(state.get('pseudo_tool_markup_nudge_streak') or 0)
            if p_streak >= MAX_AGENT_PSEUDO_TOOL_NUDGES:
                return None
            logger.info(
                'Nudging after assistant text used pseudo tool XML without API tool_calls (%s/%s LLM steps)',
                p_streak + 1,
                MAX_AGENT_PSEUDO_TOOL_NUDGES,
            )
            return {
                'messages': [HumanMessage(content=_PSEUDO_TOOL_MARKUP_NUDGE_TEXT)],
                'jump_to': 'model',
                'pseudo_tool_markup_nudge_streak': p_streak + 1,
                'empty_response_nudge_streak': 0,
            }
        if fat:
            return {
                'empty_response_nudge_streak': 0,
                'pseudo_tool_markup_nudge_streak': 0,
            }
        streak = int(state.get('empty_response_nudge_streak') or 0)
        if streak >= MAX_AGENT_EMPTY_NUDGES:
            return None
        logger.info(
            'Nudging after empty no-tool turn (langgraph) (%s/%s LLM steps)',
            streak + 1,
            MAX_AGENT_EMPTY_NUDGES,
        )
        nudge = _EMPTY_NUDGE_TEXT_HAS_TOOL_RESULTS if _has_recent_tool_results(msgs) else _EMPTY_NUDGE_TEXT
        return {
            'messages': [HumanMessage(content=nudge)],
            'jump_to': 'model',
            'empty_response_nudge_streak': streak + 1,
            'pseudo_tool_markup_nudge_streak': 0,
        }
