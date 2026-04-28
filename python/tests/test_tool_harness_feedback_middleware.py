"""Tests for harness footers and crystal polarity context."""

from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.types import Command

from nemo_backend.tool_harness_feedback_middleware import (
    ToolHarnessFeedbackMiddleware,
    is_tool_result_error,
    maybe_append_harness_footer,
    pending_harness_crystal_polarity,
    should_attach_success_note,
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
