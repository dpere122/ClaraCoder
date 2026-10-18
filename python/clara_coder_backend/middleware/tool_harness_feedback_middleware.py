"""Append harness coaching footers to tool results."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from clara_coder_backend.llm.messages import stringify_content

HARNESS_NOTE_SENTINEL = '\n---\nHarness note:'

_FAILURE_FOOTER = (
    f'{HARNESS_NOTE_SENTINEL} '
    'Recoverable tooling issue—read the error above literally; fix the smallest mismatch '
    '(path or argument shape); refresh anchors if needed; retry once with a tighter step.'
)

# Anchor-based edit tools where "repeat the identical failing call" almost always means the model is
# anchoring on stale (remembered) text instead of the file as an earlier edit left it.
_ANCHOR_EDIT_TOOL_NAMES = frozenset({'replace_workspace_snippet', 'replace_workspace_lines'})


def _repeated_failure_footer(tool_name: str, *, streak: int) -> str:
    """Escalated footer once the *same* tool call has failed with unchanged arguments back-to-back."""
    times = streak + 1
    if tool_name in _ANCHOR_EDIT_TOOL_NAMES:
        advice = (
            'Call `read_workspace_file` on this exact path now to see its **current** text, then build a new '
            '`old_snippet`/`start_line`/`end_line` from that output—not from memory.'
        )
    else:
        advice = (
            'Inspect the current state with a read-only tool before retrying, and change at least one concrete '
            'detail (path, arguments, or approach)—do not resend the same call unchanged.'
        )
    return (
        f'{HARNESS_NOTE_SENTINEL} You just called `{tool_name}` with **identical arguments** to your last '
        f'{times} attempt(s), which failed the same way every time—retrying unchanged will fail again. Stop '
        f'repeating the call. {advice}'
    )

def is_tool_result_error(text: str) -> bool:
    s = text.strip().lower()
    return s.startswith('tool error:') or s.startswith('aborted by user')


def _canonical_tool_signature(name: str, args: Any) -> str:
    """Stable ``name`` + ``args`` fingerprint so identical repeated tool calls compare equal."""
    try:
        payload = json.dumps(args, sort_keys=True, default=str)
    except Exception:
        payload = str(args)
    return f'{name}::{payload}'


def _tool_call_history_signatures(messages: list[Any]) -> list[tuple[str, bool]]:
    """Chronological ``(signature, was_error)`` for every already-resolved tool call in ``messages``."""
    tool_results: dict[str, str] = {}
    for m in messages:
        if isinstance(m, ToolMessage):
            tid = str(getattr(m, 'tool_call_id', '') or '')
            if tid:
                tool_results[tid] = stringify_content(m.content)

    out: list[tuple[str, bool]] = []
    for m in messages:
        calls = getattr(m, 'tool_calls', None) or []
        for call in calls:
            tid = str(call.get('id') or '')
            result = tool_results.get(tid)
            if result is None:
                continue  # not yet resolved (e.g. still in flight)
            sig = _canonical_tool_signature(str(call.get('name') or ''), call.get('args'))
            out.append((sig, is_tool_result_error(result)))
    return out


def trailing_identical_failure_streak(messages: list[Any], tool_name: str, args: Any) -> int:
    """Count consecutive **already-resolved** prior calls matching ``(tool_name, args)`` that all errored.

    Does not include the in-flight call itself—call before executing it. Used to detect a model blindly
    resending the exact same failing tool call instead of adapting (e.g. retrying a stale ``old_snippet``).
    """
    signature = _canonical_tool_signature(tool_name, args)
    history = _tool_call_history_signatures(messages)
    streak = 0
    for sig, was_error in reversed(history):
        if sig != signature or not was_error:
            break
        streak += 1
    return streak


def maybe_append_harness_footer(
    content: Any,
    *,
    tool_name: str,
    repeat_failure_streak: int = 0,
) -> Any:
    """Return content with a harness footer appended when applicable; otherwise unchanged.

    ``repeat_failure_streak`` is the number of consecutive *prior* calls with identical arguments to this
    same tool that already failed (0 when this is not a repeat); see :func:`trailing_identical_failure_streak`.
    """
    text = stringify_content(content).strip()
    if HARNESS_NOTE_SENTINEL in stringify_content(content):
        return content

    if is_tool_result_error(text):
        if repeat_failure_streak > 0:
            return stringify_content(content).rstrip() + _repeated_failure_footer(
                tool_name, streak=repeat_failure_streak
            )
        return stringify_content(content).rstrip() + _FAILURE_FOOTER

    return content


def _augment_tool_message(tm: ToolMessage, tool_name: str, *, repeat_failure_streak: int = 0) -> ToolMessage:
    name = tool_name or str(getattr(tm, 'name', '') or '')
    new_content = maybe_append_harness_footer(
        tm.content, tool_name=name, repeat_failure_streak=repeat_failure_streak
    )
    if new_content is tm.content:
        return tm
    return ToolMessage(
        content=new_content,
        tool_call_id=str(getattr(tm, 'tool_call_id', '') or ''),
        name=str(getattr(tm, 'name', '') or '') or name,
    )


def _augment_command(result: Command, tool_name: str, *, repeat_failure_streak: int = 0) -> Command:
    upd = getattr(result, 'update', None)
    if not isinstance(upd, dict):
        return result
    msgs = upd.get('messages')
    if not isinstance(msgs, list):
        return result
    out_msgs: list[Any] = []
    changed = False
    for m in msgs:
        if isinstance(m, ToolMessage) and not changed:
            new_tm = _augment_tool_message(m, tool_name, repeat_failure_streak=repeat_failure_streak)
            if new_tm is not m:
                changed = True
            out_msgs.append(new_tm)
        else:
            out_msgs.append(m)
    if not changed:
        return result
    new_upd = {**upd, 'messages': out_msgs}
    return Command(update=new_upd)


class ToolHarnessFeedbackMiddleware(AgentMiddleware):
    """Outermost tool wrapper: append harness coaching footers to tool results."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        name = str(request.tool_call.get('name') or '')
        state = request.state
        messages = state.get('messages') if isinstance(state, dict) else None
        repeat_streak = (
            trailing_identical_failure_streak(messages, name, request.tool_call.get('args'))
            if messages
            else 0
        )
        result = await handler(request)
        if isinstance(result, Command):
            return _augment_command(result, name, repeat_failure_streak=repeat_streak)
        if isinstance(result, ToolMessage):
            return _augment_tool_message(result, name, repeat_failure_streak=repeat_streak)
        return result


def prepend_harness_feedback_middleware(middleware: list[Any]) -> list[Any]:
    return [ToolHarnessFeedbackMiddleware(), *middleware]
