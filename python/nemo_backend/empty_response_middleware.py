"""Re-nudge the model when a LangGraph agent turn returns empty text and no tool calls.

``create_agent`` graphs otherwise treat an empty ``AIMessage`` as a finished answer;
this middleware injects a user nudge up to :data:`nemo_backend.config.MAX_AGENT_EMPTY_NUDGES` times.

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

from nemo_backend.agents.planning import NESTED_OUTER_MUTATION_TOOL_NAMES
from nemo_backend.config import MAX_AGENT_EMPTY_NUDGES
from nemo_backend.messages import final_assistant_text

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

_EMPTY_NUDGE_TEXT_AFTER_PLAN_AND_MODIFY = (
    'Your last message had no user-visible text. You already have a completed '
    'nested workspace mutation result (`plan_and_modify` or `execute_workspace_mutation`) '
    'in this conversation. First decide whether that nested workspace run satisfied the user request. '
    'If it did, answer the user now in plain language without more tools. If it did not, explain exactly '
    'what remains and why before making at most one focused next tool call.'
)

_NUDGE_REPEAT_PLAN_AND_MODIFY_AFTER_FAILURE = (
    'You called `plan_and_modify` or `execute_workspace_mutation` again with no user-visible text right after a '
    'previous nested workspace mutation result that looks unsuccessful or incomplete. '
    'Stop repeating the same tool call. Quote or paraphrase the concrete error or '
    'outcome from the last nested mutation tool message, answer the user in '
    'plain language, and only use tools again with a clearly different plan.'
)


def _has_recent_tool_results(msgs: list[Any]) -> bool:
    """True when the conversation already contains ToolMessage results."""
    return any(isinstance(m, ToolMessage) for m in msgs)


def _latest_tool_message(msgs: list[Any]) -> ToolMessage | None:
    for item in reversed(msgs):
        if isinstance(item, ToolMessage):
            return item
    return None


def _aimessage_tool_names(msg: AIMessage) -> list[str]:
    names: list[str] = []
    for tc in msg.tool_calls or []:
        if isinstance(tc, dict):
            names.append(str(tc.get('name') or '').strip())
        else:
            names.append(str(getattr(tc, 'name', '') or '').strip())
    return [n for n in names if n]


def _is_successful_outer_nested_mutation_tool(msg: ToolMessage | None) -> bool:
    if msg is None:
        return False
    if str(getattr(msg, 'name', '') or '').strip() not in NESTED_OUTER_MUTATION_TOOL_NAMES:
        return False
    text = str(getattr(msg, 'content', '') or '').strip().lower()
    if text.startswith('tool error:'):
        return False
    if not text:
        return False
    # Nested planner often returns natural-language failure summaries without the prefix.
    failure_markers = (
        'could not',
        'couldn\'t',
        'unable to',
        'failed',
        'without a final',
        'not be found',
        'does not exist',
        'no active session',
        'planning stream not initialized',
        'i\'m sorry',
        'sorry, but',
    )
    return not any(marker in text for marker in failure_markers)


class _EmptyResponseNudgeState(AgentState[ResponseT]):
    """Tracks empty no-tool model turns for nudging (not exposed in I/O schema)."""

    empty_response_nudge_streak: NotRequired[Annotated[int, PrivateStateAttr]]
    post_tool_silent_tool_streak: NotRequired[Annotated[int, PrivateStateAttr]]


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
                return {'empty_response_nudge_streak': 0, 'post_tool_silent_tool_streak': 0}
            prior_msgs = msgs[:-1]
            if any(isinstance(m, ToolMessage) for m in prior_msgs):
                latest_tool = _latest_tool_message(prior_msgs)
                lt_name = str(getattr(latest_tool, 'name', '') or '').strip() if latest_tool else ''
                # Typical flow: list/read/search then nested mutation — must not count as spam.
                if lt_name not in NESTED_OUTER_MUTATION_TOOL_NAMES:
                    return {'post_tool_silent_tool_streak': 0, 'empty_response_nudge_streak': 0}
                if _is_successful_outer_nested_mutation_tool(latest_tool):
                    return {'post_tool_silent_tool_streak': 0, 'empty_response_nudge_streak': 0}
                # Unsuccessful nested mutation: only count if the model doubles down with the same class of tool again
                # (not when it switches to read/list tools after a failure).
                names_called = set(_aimessage_tool_names(last))
                if not (names_called & NESTED_OUTER_MUTATION_TOOL_NAMES):
                    return {'post_tool_silent_tool_streak': 0, 'empty_response_nudge_streak': 0}
                silent = int(state.get('post_tool_silent_tool_streak') or 0) + 1
                if silent >= 2:
                    logger.info(
                        'Nudging after repeated silent nested mutation calls following an unsuccessful one '
                        '(silent=%s)',
                        silent,
                    )
                    return {
                        'messages': [HumanMessage(content=_NUDGE_REPEAT_PLAN_AND_MODIFY_AFTER_FAILURE)],
                        'jump_to': 'model',
                        'post_tool_silent_tool_streak': 0,
                        'empty_response_nudge_streak': 0,
                    }
                return {'post_tool_silent_tool_streak': silent, 'empty_response_nudge_streak': 0}
            return {'empty_response_nudge_streak': 0, 'post_tool_silent_tool_streak': 0}
        inv = getattr(last, 'invalid_tool_calls', None) or ()
        if inv:
            return None
        if final_assistant_text(last).strip():
            return {'empty_response_nudge_streak': 0, 'post_tool_silent_tool_streak': 0}
        streak = int(state.get('empty_response_nudge_streak') or 0)
        if streak >= MAX_AGENT_EMPTY_NUDGES:
            return None
        logger.info(
            'Nudging after empty no-tool turn (langgraph) (%s/%s LLM steps)',
            streak + 1,
            MAX_AGENT_EMPTY_NUDGES,
        )
        latest_tool = _latest_tool_message(msgs[:-1])
        nudge = (
            _EMPTY_NUDGE_TEXT_AFTER_PLAN_AND_MODIFY
            if _is_successful_outer_nested_mutation_tool(latest_tool)
            else (
                _EMPTY_NUDGE_TEXT_HAS_TOOL_RESULTS
                if _has_recent_tool_results(msgs)
                else _EMPTY_NUDGE_TEXT
            )
        )
        return {
            'messages': [HumanMessage(content=nudge)],
            'jump_to': 'model',
            'empty_response_nudge_streak': streak + 1,
        }
