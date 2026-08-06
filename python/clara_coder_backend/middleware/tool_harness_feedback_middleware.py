"""Append harness coaching footers to tool results."""

from __future__ import annotations

import json
import re
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
    '(path, argument shape, or workspace vs staging); refresh anchors if needed; retry once with a tighter step.'
)

# Anchor-based staging tools where "repeat the identical failing call" almost always means the model is
# anchoring on stale (disk or remembered) text instead of the current staged draft.
_ANCHOR_STAGING_TOOL_NAMES = frozenset({'stage_snippet_edit', 'stage_line_range_edit'})


def _repeated_failure_footer(tool_name: str, *, streak: int) -> str:
    """Escalated footer once the *same* tool call has failed with unchanged arguments back-to-back."""
    times = streak + 1
    if tool_name in _ANCHOR_STAGING_TOOL_NAMES:
        advice = (
            'Call `read_staged_edit` on this exact path now to see its **current** text, then build a new '
            '`old_snippet`/`start_line`/`end_line` from that output—not from `read_workspace_file`, a diff, or memory.'
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

_SUCCESS_FOOTER = (
    f'{HARNESS_NOTE_SENTINEL} '
    'Solid progress—this step succeeded. Briefly confirm the outcome for the user and continue with the next safe action.'
)

_MILESTONE_TOOL_NAMES = frozenset(
    {
        'transfer_staged_file_to_workspace',
        'run_staging_overlay_command',
    }
)

_PYTEST_FAILURE_RE = re.compile(r'\b\d+\s+failed\b', re.IGNORECASE)


def is_tool_result_error(text: str) -> bool:
    s = text.strip().lower()
    return s.startswith('tool error:') or s.startswith('aborted by user')


def _pytest_body_suggests_failure(text: str) -> bool:
    low = text.lower()
    if 'tool error:' in low:
        return True
    if _PYTEST_FAILURE_RE.search(text):
        return True
    if 'traceback' in low and 'error' in low:
        return True
    if 'staging overlay command summary' in low:
        if 'result: failed' in low:
            return True
        m = re.search(r'exit code:\s*(\d+)', low)
        if m and m.group(1) != '0':
            return True
    return False


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


def should_attach_success_note(tool_name: str, text: str) -> bool:
    if is_tool_result_error(text):
        return False
    name = (tool_name or '').strip()
    if name not in _MILESTONE_TOOL_NAMES:
        return False
    if name == 'run_staging_overlay_command':
        return not _pytest_body_suggests_failure(text)
    return bool(text.strip())


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

    if should_attach_success_note(tool_name, text):
        return stringify_content(content).rstrip() + _SUCCESS_FOOTER

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
