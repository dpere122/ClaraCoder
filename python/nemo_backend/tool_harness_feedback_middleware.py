"""Append harness coaching footers to tool results and signal crystal polarity for SSE."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any, Literal

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from nemo_backend.messages import stringify_content

HarnessPolarity = Literal['positive', 'negative']

HARNESS_NOTE_SENTINEL = '\n---\nHarness note:'

pending_harness_crystal_polarity: ContextVar[HarnessPolarity | None] = ContextVar(
    'pending_harness_crystal_polarity',
    default=None,
)

_FAILURE_FOOTER = (
    f'{HARNESS_NOTE_SENTINEL} '
    'Recoverable tooling issue—read the error above literally; fix the smallest mismatch '
    '(path, argument shape, or workspace vs staging); refresh anchors if needed; retry once with a tighter step.'
)

_SUCCESS_FOOTER = (
    f'{HARNESS_NOTE_SENTINEL} '
    'Solid progress—this step succeeded. Briefly confirm the outcome for the user and continue with the next safe action.'
)

_MILESTONE_TOOL_NAMES = frozenset(
    {
        'transfer_staged_file_to_workspace',
        'plan_and_modify',
        'execute_workspace_mutation',
        'run_workspace_pytest_tests',
        'run_workspace_python_smoke_test',
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


def should_attach_success_note(tool_name: str, text: str) -> bool:
    if is_tool_result_error(text):
        return False
    name = (tool_name or '').strip()
    if name not in _MILESTONE_TOOL_NAMES:
        return False
    if name in ('run_workspace_pytest_tests', 'run_workspace_python_smoke_test', 'run_staging_overlay_command'):
        return not _pytest_body_suggests_failure(text)
    return bool(text.strip())


def maybe_append_harness_footer(content: Any, *, tool_name: str) -> tuple[Any, HarnessPolarity | None]:
    """Return (new_content, polarity) when a footer was attached; polarity None if unchanged."""
    text = stringify_content(content).strip()
    if HARNESS_NOTE_SENTINEL in stringify_content(content):
        return content, None

    if is_tool_result_error(text):
        merged = stringify_content(content).rstrip() + _FAILURE_FOOTER
        return merged, 'negative'

    if should_attach_success_note(tool_name, text):
        merged = stringify_content(content).rstrip() + _SUCCESS_FOOTER
        return merged, 'positive'

    return content, None


def _set_crystal_polarity(pol: HarnessPolarity | None) -> None:
    if pol is None:
        return
    pending_harness_crystal_polarity.set(pol)


def _augment_tool_message(tm: ToolMessage, tool_name: str) -> ToolMessage:
    name = tool_name or str(getattr(tm, 'name', '') or '')
    new_content, pol = maybe_append_harness_footer(tm.content, tool_name=name)
    if pol is None:
        return tm
    _set_crystal_polarity(pol)
    return ToolMessage(
        content=new_content,
        tool_call_id=str(getattr(tm, 'tool_call_id', '') or ''),
        name=str(getattr(tm, 'name', '') or '') or name,
    )


def _augment_command(result: Command, tool_name: str) -> Command:
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
            new_tm = _augment_tool_message(m, tool_name)
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
    """Outermost tool wrapper: append harness footers and set crystal polarity contextvar."""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        name = str(request.tool_call.get('name') or '')
        result = await handler(request)
        if isinstance(result, Command):
            return _augment_command(result, name)
        if isinstance(result, ToolMessage):
            return _augment_tool_message(result, name)
        return result


def prepend_harness_feedback_middleware(middleware: list[Any]) -> list[Any]:
    return [ToolHarnessFeedbackMiddleware(), *middleware]
