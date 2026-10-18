"""Tests for harness coaching footers on tool results."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from clara_coder_backend.middleware.tool_harness_feedback_middleware import (
    ToolHarnessFeedbackMiddleware,
    is_tool_result_error,
    maybe_append_harness_footer,
    trailing_identical_failure_streak,
)


def test_is_tool_result_error() -> None:
    assert is_tool_result_error('Tool error: nope')
    assert is_tool_result_error('  tool error: x')
    assert is_tool_result_error('Aborted by user.')
    assert not is_tool_result_error('ok')


def test_maybe_append_harness_footer_failure() -> None:
    text = 'Tool error: bad path'
    out = maybe_append_harness_footer(text, tool_name='read_workspace_file')
    assert 'Harness note:' in out
    assert 'Recoverable tooling issue' in out


def test_maybe_append_harness_footer_skips_read_tools() -> None:
    text = 'file contents here'
    out = maybe_append_harness_footer(text, tool_name='read_workspace_file')
    assert out == text


def test_maybe_append_harness_footer_idempotent() -> None:
    base = 'Tool error: x\n---\nHarness note: already there'
    out = maybe_append_harness_footer(base, tool_name='t')
    assert out == base


def _failed_call(name: str, args: dict, call_id: str) -> list[Any]:
    return [
        AIMessage(content='', tool_calls=[{'name': name, 'args': args, 'id': call_id}]),
        ToolMessage(content='Tool error: old_snippet not found in file.', tool_call_id=call_id, name=name),
    ]


def test_trailing_identical_failure_streak_counts_consecutive_identical_errors() -> None:
    args = {'relative_path': 'a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}
    messages: list[Any] = []
    messages += _failed_call('replace_workspace_snippet', args, 'c1')
    messages += _failed_call('replace_workspace_snippet', args, 'c2')
    messages += _failed_call('replace_workspace_snippet', args, 'c3')

    assert trailing_identical_failure_streak(messages, 'replace_workspace_snippet', args) == 3


def test_trailing_identical_failure_streak_is_zero_for_first_attempt() -> None:
    args = {'relative_path': 'a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}
    assert trailing_identical_failure_streak([], 'replace_workspace_snippet', args) == 0


def test_trailing_identical_failure_streak_resets_on_different_args() -> None:
    args1 = {'relative_path': 'a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}
    args2 = {'relative_path': 'a.ts', 'old_snippet': 'z', 'new_snippet': 'y'}
    messages: list[Any] = []
    messages += _failed_call('replace_workspace_snippet', args1, 'c1')
    messages += _failed_call('replace_workspace_snippet', args2, 'c2')  # different old_snippet: breaks the streak

    assert trailing_identical_failure_streak(messages, 'replace_workspace_snippet', args2) == 1
    assert trailing_identical_failure_streak(messages, 'replace_workspace_snippet', args1) == 0


def test_trailing_identical_failure_streak_resets_after_a_success() -> None:
    args = {'relative_path': 'a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}
    messages: list[Any] = [
        AIMessage(content='', tool_calls=[{'name': 'replace_workspace_snippet', 'args': args, 'id': 'c1'}]),
        ToolMessage(content='Tool error: old_snippet not found in file.', tool_call_id='c1', name='replace_workspace_snippet'),
        AIMessage(content='', tool_calls=[{'name': 'replace_workspace_snippet', 'args': args, 'id': 'c2'}]),
        ToolMessage(content='Staged `a.ts` for review.', tool_call_id='c2', name='replace_workspace_snippet'),
    ]
    assert trailing_identical_failure_streak(messages, 'replace_workspace_snippet', args) == 0


def test_maybe_append_harness_footer_repeat_failure_names_the_edit_tool() -> None:
    text = 'Tool error: old_snippet not found in file.'
    out = maybe_append_harness_footer(text, tool_name='replace_workspace_snippet', repeat_failure_streak=2)
    assert 'identical arguments' in out
    assert 'read_workspace_file' in out
    assert '3 attempt(s)' in out


def test_maybe_append_harness_footer_repeat_failure_generic_tool_advice() -> None:
    text = 'Tool error: something went wrong.'
    out = maybe_append_harness_footer(text, tool_name='some_other_tool', repeat_failure_streak=1)
    assert 'identical arguments' in out
    assert 'read_workspace_file' not in out
    assert 'Inspect the current state' in out


@pytest.mark.asyncio
async def test_middleware_escalates_footer_on_repeated_identical_failing_call() -> None:
    args = {'relative_path': 'renderer.ts', 'old_snippet': 'stale text', 'new_snippet': 'new text'}
    prior_messages: list[Any] = []
    prior_messages += _failed_call('replace_workspace_snippet', args, 'c1')
    prior_messages += _failed_call('replace_workspace_snippet', args, 'c2')

    async def handler(_req):
        return ToolMessage(
            content='Tool error: old_snippet not found in file.',
            tool_call_id='c3',
            name='replace_workspace_snippet',
        )

    mw = ToolHarnessFeedbackMiddleware()
    from langgraph.prebuilt.tool_node import ToolCallRequest

    req = ToolCallRequest(
        tool_call={'name': 'replace_workspace_snippet', 'id': 'c3', 'args': args},
        tool=None,
        state={'messages': prior_messages},  # type: ignore[arg-type]
        runtime=None,  # type: ignore[arg-type]
    )
    out = await mw.awrap_tool_call(req, handler)
    assert isinstance(out, ToolMessage)
    assert 'identical arguments' in str(out.content)
    assert 'read_workspace_file' in str(out.content)
    assert '3 attempt(s)' in str(out.content)


@pytest.mark.asyncio
async def test_middleware_uses_generic_footer_on_first_failure_with_history() -> None:
    """A first-time failure alongside unrelated history should not trigger the repeat escalation."""
    args = {'relative_path': 'renderer.ts', 'old_snippet': 'brand new anchor', 'new_snippet': 'new text'}
    other_args = {'relative_path': 'other.ts', 'old_snippet': 'a', 'new_snippet': 'b'}
    prior_messages = _failed_call('replace_workspace_snippet', other_args, 'c1')

    async def handler(_req):
        return ToolMessage(
            content='Tool error: old_snippet not found in file.',
            tool_call_id='c2',
            name='replace_workspace_snippet',
        )

    mw = ToolHarnessFeedbackMiddleware()
    from langgraph.prebuilt.tool_node import ToolCallRequest

    req = ToolCallRequest(
        tool_call={'name': 'replace_workspace_snippet', 'id': 'c2', 'args': args},
        tool=None,
        state={'messages': prior_messages},  # type: ignore[arg-type]
        runtime=None,  # type: ignore[arg-type]
    )
    out = await mw.awrap_tool_call(req, handler)
    assert isinstance(out, ToolMessage)
    assert 'identical arguments' not in str(out.content)
    assert 'Recoverable tooling issue' in str(out.content)


@pytest.mark.asyncio
async def test_middleware_appends_footer_on_toolmessage() -> None:
    async def handler(_req):
        return ToolMessage(content='Tool error: test', tool_call_id='c1', name='read_workspace_file')

    mw = ToolHarnessFeedbackMiddleware()
    from langgraph.prebuilt.tool_node import ToolCallRequest

    req = ToolCallRequest(
        tool_call={'name': 'read_workspace_file', 'id': 'c1', 'args': {}},
        tool=None,
        state={},  # type: ignore[arg-type]
        runtime=None,  # type: ignore[arg-type]
    )
    out = await mw.awrap_tool_call(req, handler)
    assert isinstance(out, ToolMessage)
    assert 'Harness note:' in str(out.content)


@pytest.mark.asyncio
async def test_middleware_command_first_toolmessage() -> None:
    async def handler(_req):
        return Command(
            update={
                'messages': [
                    ToolMessage(content='Tool error: x', tool_call_id='c1', name='x'),
                    HumanMessage(content='note'),
                ],
            },
        )

    mw = ToolHarnessFeedbackMiddleware()
    from langgraph.prebuilt.tool_node import ToolCallRequest

    req = ToolCallRequest(
        tool_call={'name': 'x', 'id': 'c1', 'args': {}},
        tool=None,
        state={},  # type: ignore[arg-type]
        runtime=None,  # type: ignore[arg-type]
    )
    out = await mw.awrap_tool_call(req, handler)
    assert isinstance(out, Command)
    msgs = out.update['messages']
    assert 'Harness note:' in str(msgs[0].content)
    assert msgs[1].content == 'note'
