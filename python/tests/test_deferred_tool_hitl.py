"""Tests for deferred execute-tool HITL staging."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from nemo_backend.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL, execute_pending_accept_command_decision
from nemo_backend.deferred_tool_hitl import (
    DEFERRED_HITL_TOOL_NAMES,
    deferred_tool_hitl_bypass,
    maybe_await_hitl_for_deferred_tool,
)
from nemo_backend.tools.python_env import ENSURE_PYTHON_WORKSPACE_ENV_NAME
from nemo_backend.state import current_session_id, get_session
from nemo_backend.tool_registry import hitl_accept_command_pause_tools


def test_deferred_hitl_tools_in_accept_command_pause_registry() -> None:
    assert DEFERRED_HITL_TOOL_NAMES <= hitl_accept_command_pause_tools()


def test_maybe_await_hitl_stages_pending_when_auto_apply_off() -> None:
    session = get_session('deferred-hitl-stage')
    session.auto_apply_mode = False
    msg = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name=ENSURE_PYTHON_WORKSPACE_ENV_NAME,
        tool_input={},
    )
    assert msg and 'Pending user confirmation' in msg
    pending = session.pending_accept_command_request
    assert pending is not None
    assert pending['kind'] == ACCEPT_COMMAND_KIND_DEFERRED_TOOL
    assert pending['action']['tool_name'] == ENSURE_PYTHON_WORKSPACE_ENV_NAME


def test_maybe_await_hitl_skips_when_auto_apply_on() -> None:
    session = get_session('deferred-hitl-auto')
    session.auto_apply_mode = True
    assert maybe_await_hitl_for_deferred_tool(session, tool_name=ENSURE_PYTHON_WORKSPACE_ENV_NAME) is None
    assert session.pending_accept_command_request is None


def test_maybe_await_hitl_skips_when_plan_step_bypass_active() -> None:
    session = get_session('deferred-hitl-plan-step')
    session.auto_apply_mode = False
    token = deferred_tool_hitl_bypass.set(True)
    try:
        assert (
            maybe_await_hitl_for_deferred_tool(
                session,
                tool_name='run_workspace_pytest_tests',
                tool_input={},
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
        'request_id': 'req-deferred-env',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Initialize workspace Python environment',
        'message': 'm',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': 'python -m venv .venv',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {'tool_name': ENSURE_PYTHON_WORKSPACE_ENV_NAME, 'tool_input': {}},
    }

    async def _fake_ensure(session_arg, **kwargs):
        assert (current_session_id.get() or '').strip() == session_id
        assert session_arg is session
        return type('R', (), {'summary': 'venv ready'})()

    monkeypatch.setattr(
        'nemo_backend.tools.python_env.ensure_session_python_workspace_env',
        _fake_ensure,
    )

    note = await execute_pending_accept_command_decision(
        session,
        confirm=True,
        request_id='req-deferred-env',
    )
    assert note == 'venv ready'
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
        'title': 'Run workspace pytest',
        'message': 'm',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': 'pytest',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {'tool_name': 'run_workspace_pytest_tests', 'tool_input': {}},
    }
    try:
        with patch(
            'nemo_backend.deferred_tool_hitl._resolve_deferred_tool',
            return_value=AsyncMock(ainvoke=AsyncMock(return_value='pytest ok')),
        ) as resolve_mock:
            note = await execute_pending_accept_command_decision(session, confirm=True, request_id='req-deferred-1')
        resolve_mock.assert_called_once_with('run_workspace_pytest_tests')
        assert note == 'pytest ok'
        assert session.pending_accept_command_request is None
    finally:
        current_session_id.reset(token)
