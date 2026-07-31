"""Tests for harness footers and crystal polarity context."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from clara_coder_backend.middleware.tool_harness_feedback_middleware import (
    ToolHarnessFeedbackMiddleware,
    is_tool_result_error,
    maybe_append_harness_footer,
    pending_harness_crystal_polarity,
    should_attach_success_note,
    trailing_identical_failure_streak,
)


def test_is_tool_result_error() -> None:
    assert is_tool_result_error('Tool error: nope')
    assert is_tool_result_error('  tool error: x')
    assert is_tool_result_error('Aborted by user.')
    assert not is_tool_result_error('ok')


def test_maybe_append_harness_footer_failure_sets_negative() -> None:
    text = 'Tool error: bad path'
    out, pol = maybe_append_harness_footer(text, tool_name='read_workspace_file')
    assert pol == 'negative'
    assert 'Harness note:' in out
    assert 'Recoverable tooling issue' in out


def test_maybe_append_harness_footer_success_milestone() -> None:
    text = 'Transferred staged `foo.py` to workspace.'
    out, pol = maybe_append_harness_footer(text, tool_name='transfer_staged_file_to_workspace')
    assert pol == 'positive'
    assert 'Solid progress' in out


def test_maybe_append_harness_footer_skips_read_tools() -> None:
    text = 'file contents here'
    out, pol = maybe_append_harness_footer(text, tool_name='read_workspace_file')
    assert pol is None
    assert out == text


def test_maybe_append_harness_footer_idempotent() -> None:
    base = 'Tool error: x\n---\nHarness note: already there'
    out, pol = maybe_append_harness_footer(base, tool_name='t')
    assert pol is None
    assert out == base


def test_should_attach_success_note_pytest_heuristic() -> None:
    ok_run = '===== 3 passed in 1.2s ====='
    assert should_attach_success_note('run_workspace_pytest_tests', ok_run)
    bad = '===== 1 failed, 2 passed in 1s ====='
    assert not should_attach_success_note('run_workspace_pytest_tests', bad)


def test_should_attach_success_note_staging_overlay_heuristic() -> None:
    ok_run = 'Staging overlay command summary:\n- Result: passed\n- Exit code: 0\n'
    assert should_attach_success_note('run_staging_overlay_command', ok_run)
    bad = 'Staging overlay command summary:\n- Result: failed\n- Exit code: 1\n'
    assert not should_attach_success_note('run_staging_overlay_command', bad)


def _failed_call(name: str, args: dict, call_id: str) -> list[Any]:
    return [
        AIMessage(content='', tool_calls=[{'name': name, 'args': args, 'id': call_id}]),
        ToolMessage(content='Tool error: old_snippet not found in file.', tool_call_id=call_id, name=name),
    ]


def test_trailing_identical_failure_streak_counts_consecutive_identical_errors() -> None:
    args = {'relative_path': 'a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}
    messages: list[Any] = []
    messages += _failed_call('stage_snippet_edit', args, 'c1')
    messages += _failed_call('stage_snippet_edit', args, 'c2')
    messages += _failed_call('stage_snippet_edit', args, 'c3')

    assert trailing_identical_failure_streak(messages, 'stage_snippet_edit', args) == 3


def test_trailing_identical_failure_streak_is_zero_for_first_attempt() -> None:
    args = {'relative_path': 'a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}
    assert trailing_identical_failure_streak([], 'stage_snippet_edit', args) == 0


def test_trailing_identical_failure_streak_resets_on_different_args() -> None:
    args1 = {'relative_path': 'a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}
    args2 = {'relative_path': 'a.ts', 'old_snippet': 'z', 'new_snippet': 'y'}
    messages: list[Any] = []
    messages += _failed_call('stage_snippet_edit', args1, 'c1')
    messages += _failed_call('stage_snippet_edit', args2, 'c2')  # different old_snippet: breaks the streak

    assert trailing_identical_failure_streak(messages, 'stage_snippet_edit', args2) == 1
    assert trailing_identical_failure_streak(messages, 'stage_snippet_edit', args1) == 0


def test_trailing_identical_failure_streak_resets_after_a_success() -> None:
    args = {'relative_path': 'a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}
    messages: list[Any] = [
        AIMessage(content='', tool_calls=[{'name': 'stage_snippet_edit', 'args': args, 'id': 'c1'}]),
        ToolMessage(content='Tool error: old_snippet not found in file.', tool_call_id='c1', name='stage_snippet_edit'),
        AIMessage(content='', tool_calls=[{'name': 'stage_snippet_edit', 'args': args, 'id': 'c2'}]),
        ToolMessage(content='Staged `a.ts` for review.', tool_call_id='c2', name='stage_snippet_edit'),
    ]
    assert trailing_identical_failure_streak(messages, 'stage_snippet_edit', args) == 0


def test_maybe_append_harness_footer_repeat_failure_names_the_staging_tool() -> None:
    text = 'Tool error: old_snippet not found in file.'
    out, pol = maybe_append_harness_footer(text, tool_name='stage_snippet_edit', repeat_failure_streak=2)
    assert pol == 'negative'
    assert 'identical arguments' in out
    assert 'read_staged_edit' in out
    assert '3 attempt(s)' in out


def test_maybe_append_harness_footer_repeat_failure_generic_tool_advice() -> None:
    text = 'Tool error: something went wrong.'
    out, pol = maybe_append_harness_footer(text, tool_name='some_other_tool', repeat_failure_streak=1)
    assert pol == 'negative'
    assert 'identical arguments' in out
    assert 'read_staged_edit' not in out
    assert 'Inspect the current state' in out


@pytest.mark.asyncio
async def test_middleware_escalates_footer_on_repeated_identical_failing_call() -> None:
    pending_harness_crystal_polarity.set(None)
    args = {'relative_path': 'renderer.ts', 'old_snippet': 'stale text', 'new_snippet': 'new text'}
    prior_messages: list[Any] = []
    prior_messages += _failed_call('stage_snippet_edit', args, 'c1')
    prior_messages += _failed_call('stage_snippet_edit', args, 'c2')

    async def handler(_req):
        return ToolMessage(
            content='Tool error: old_snippet not found in file.',
            tool_call_id='c3',
            name='stage_snippet_edit',
        )

    mw = ToolHarnessFeedbackMiddleware()
    from langgraph.prebuilt.tool_node import ToolCallRequest

    req = ToolCallRequest(
        tool_call={'name': 'stage_snippet_edit', 'id': 'c3', 'args': args},
        tool=None,
        state={'messages': prior_messages},  # type: ignore[arg-type]
        runtime=None,  # type: ignore[arg-type]
    )
    out = await mw.awrap_tool_call(req, handler)
    assert isinstance(out, ToolMessage)
    assert 'identical arguments' in str(out.content)
    assert 'read_staged_edit' in str(out.content)
    assert '3 attempt(s)' in str(out.content)
    assert pending_harness_crystal_polarity.get() == 'negative'


@pytest.mark.asyncio
async def test_middleware_uses_generic_footer_on_first_failure_with_history() -> None:
    """A first-time failure alongside unrelated history should not trigger the repeat escalation."""
    pending_harness_crystal_polarity.set(None)
    args = {'relative_path': 'renderer.ts', 'old_snippet': 'brand new anchor', 'new_snippet': 'new text'}
    other_args = {'relative_path': 'other.ts', 'old_snippet': 'a', 'new_snippet': 'b'}
    prior_messages = _failed_call('stage_snippet_edit', other_args, 'c1')

    async def handler(_req):
        return ToolMessage(
            content='Tool error: old_snippet not found in file.',
            tool_call_id='c2',
            name='stage_snippet_edit',
        )

    mw = ToolHarnessFeedbackMiddleware()
    from langgraph.prebuilt.tool_node import ToolCallRequest

    req = ToolCallRequest(
        tool_call={'name': 'stage_snippet_edit', 'id': 'c2', 'args': args},
        tool=None,
        state={'messages': prior_messages},  # type: ignore[arg-type]
        runtime=None,  # type: ignore[arg-type]
    )
    out = await mw.awrap_tool_call(req, handler)
    assert isinstance(out, ToolMessage)
    assert 'identical arguments' not in str(out.content)
    assert 'Recoverable tooling issue' in str(out.content)


@pytest.mark.asyncio
async def test_middleware_sets_contextvar_on_toolmessage() -> None:
    pending_harness_crystal_polarity.set(None)

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
    assert pending_harness_crystal_polarity.get() == 'negative'


@pytest.mark.asyncio
async def test_middleware_command_first_toolmessage() -> None:
    pending_harness_crystal_polarity.set(None)

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
