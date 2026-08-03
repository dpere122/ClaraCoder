"""Tests for deferred execute-tool HITL staging."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL, execute_pending_accept_command_decision
from clara_coder_backend.hitl.deferred_tool_hitl import (
    DEFERRED_HITL_TOOL_NAMES,
    deferred_tool_hitl_bypass,
    maybe_await_hitl_for_deferred_tool,
)
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.hitl.tool_registry import hitl_accept_command_pause_tools


def test_deferred_hitl_tools_in_accept_command_pause_registry() -> None:
    assert DEFERRED_HITL_TOOL_NAMES <= hitl_accept_command_pause_tools()


def test_maybe_await_hitl_stages_pending_when_auto_apply_off() -> None:
    session = get_session('deferred-hitl-stage')
    session.auto_apply_mode = False
    msg = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name='run_command',
        tool_input={'command': 'ls -la', 'cwd': '.'},
    )
    assert msg and 'Pending user confirmation' in msg
    pending = session.pending_accept_command_request
    assert pending is not None
    assert pending['kind'] == ACCEPT_COMMAND_KIND_DEFERRED_TOOL
    assert pending['action']['tool_name'] == 'run_command'


def test_maybe_await_hitl_skips_when_auto_apply_on() -> None:
    session = get_session('deferred-hitl-auto')
    session.auto_apply_mode = True
    assert maybe_await_hitl_for_deferred_tool(session, tool_name='run_command') is None
    assert session.pending_accept_command_request is None


def test_maybe_await_hitl_skips_when_plan_step_bypass_active() -> None:
    session = get_session('deferred-hitl-plan-step')
    session.auto_apply_mode = False
    token = deferred_tool_hitl_bypass.set(True)
    try:
        assert (
            maybe_await_hitl_for_deferred_tool(
                session,
                tool_name='run_staging_overlay_command',
                tool_input={'command_argv_json': '["npm", "test"]', 'cwd_relative': '.'},
            )
            is None
        )
        assert session.pending_accept_command_request is None
    finally:
        deferred_tool_hitl_bypass.reset(token)


@pytest.mark.asyncio(loop_scope='function')
async def test_execute_pending_deferred_tool_sets_session_context_for_hitl_confirm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: agent-continue runs outside the streaming task, so session context must be restored."""

    session_id = 'deferred-hitl-session-context'
    session = get_session(session_id)
    session.workspace_path = '/tmp/workspace'
    session.pending_accept_command_request = {
        'request_id': 'req-deferred-cmd',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run terminal command',
        'message': 'm',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': 'ls -la',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {'tool_name': 'run_command', 'tool_input': {'command': 'ls -la', 'cwd': '.'}},
    }

    mock_tool = AsyncMock()
    mock_tool.ainvoke = AsyncMock(return_value='command ok')

    with patch(
        'clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool',
        return_value=mock_tool,
    ) as resolve_mock:
        note = await execute_pending_accept_command_decision(
            session,
            confirm=True,
            request_id='req-deferred-cmd',
        )

    resolve_mock.assert_called_once_with('run_command')
    mock_tool.ainvoke.assert_awaited_once_with({'command': 'ls -la', 'cwd': '.'})
    assert note == 'command ok'
    assert session.pending_accept_command_request is None
    assert (current_session_id.get() or '').strip() == ''


@pytest.mark.asyncio(loop_scope='function')
async def test_execute_pending_deferred_tool_runs_after_confirm() -> None:
    session_id = 'deferred-hitl-exec'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.pending_accept_command_request = {
        'request_id': 'req-deferred-1',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run staging overlay command',
        'message': 'm',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': 'npm test',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {
            'tool_name': 'run_staging_overlay_command',
            'tool_input': {'command_argv_json': '["npm", "test"]', 'cwd_relative': '.'},
        },
    }
    try:
        with patch(
            'clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool',
            return_value=AsyncMock(ainvoke=AsyncMock(return_value='overlay ok')),
        ) as resolve_mock:
            note = await execute_pending_accept_command_decision(session, confirm=True, request_id='req-deferred-1')
        resolve_mock.assert_called_once_with('run_staging_overlay_command')
        assert note == 'overlay ok'
        assert session.pending_accept_command_request is None
    finally:
        current_session_id.reset(token)
