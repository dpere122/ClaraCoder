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
from clara_coder_backend.tools.deferred_hitl import (
    ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
    maybe_await_hitl_for_admin_elevation,
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


def test_admin_elevation_hitl_stages_even_when_auto_apply_on() -> None:
    session = get_session('deferred-hitl-admin-stage')
    session.auto_apply_mode = True
    session.admin_elevation_granted = False
    session.pending_accept_command_request = None
    msg = maybe_await_hitl_for_admin_elevation(
        session,
        tool_name='run_command',
        tool_input={'command': 'apt update', 'cwd': '.', 'elevate': True},
    )
    assert 'administrator access' in msg
    pending = session.pending_accept_command_request
    assert pending is not None
    assert pending['kind'] == ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL
    assert pending['confirm_label'] == 'Allow'
    assert pending['command_text'] == ''
    assert 'confirm_session_label' not in pending


def test_elevate_does_not_force_hitl_when_auto_apply_on() -> None:
    session = get_session('deferred-hitl-elevate-auto')
    session.auto_apply_mode = True
    session.admin_elevation_granted = False
    session.pending_accept_command_request = None
    assert (
        maybe_await_hitl_for_deferred_tool(
            session,
            tool_name='run_command',
            tool_input={'command': 'apt update', 'cwd': '.', 'elevate': True},
        )
        is None
    )
    assert session.pending_accept_command_request is None


def test_elevate_false_hitl_has_no_session_label() -> None:
    session = get_session('deferred-hitl-no-elevate')
    session.auto_apply_mode = False
    session.pending_accept_command_request = None
    maybe_await_hitl_for_deferred_tool(
        session,
        tool_name='run_command',
        tool_input={'command': 'echo hi', 'cwd': '.'},
    )
    pending = session.pending_accept_command_request
    assert pending is not None
    assert pending['confirm_label'] == 'Run'
    assert 'confirm_session_label' not in pending


def test_elevate_hitl_skips_when_session_granted_and_auto_apply_on() -> None:
    session = get_session('deferred-hitl-elevate-granted-auto')
    session.auto_apply_mode = True
    session.admin_elevation_granted = True
    session.pending_accept_command_request = None
    assert (
        maybe_await_hitl_for_deferred_tool(
            session,
            tool_name='run_command',
            tool_input={'command': 'apt update', 'elevate': True},
        )
        is None
    )
    assert session.pending_accept_command_request is None


def test_elevate_hitl_still_asks_when_session_granted_and_auto_apply_off() -> None:
    session = get_session('deferred-hitl-elevate-granted-manual')
    session.auto_apply_mode = False
    session.admin_elevation_granted = True
    session.pending_accept_command_request = None
    msg = maybe_await_hitl_for_deferred_tool(
        session,
        tool_name='run_command',
        tool_input={'command': 'apt update', 'elevate': True},
    )
    assert msg and 'Pending user confirmation' in msg
    pending = session.pending_accept_command_request
    assert pending is not None
    assert pending['confirm_label'] == 'Run'
    assert 'confirm_session_label' not in pending
    assert pending['action']['tool_input']['elevate'] is True


@pytest.mark.asyncio(loop_scope='function')
async def test_confirm_admin_elevation_tool_warms_helper_then_executes() -> None:
    session = get_session('deferred-hitl-admin-tool')
    session.admin_elevation_granted = False
    session.pending_accept_command_request = {
        'request_id': 'req-admin-tool',
        'kind': ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
        'title': 'Grant administrator access',
        'message': 'm',
        'confirm_label': 'Allow',
        'cancel_label': 'Cancel',
        'command_text': '',
        'details': [],
        'cancel_note': 'User declined administrator access for this agent.',
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'apt update', 'cwd': '.', 'elevate': True},
        },
    }
    with (
        patch(
            'clara_coder_backend.runtime.admin_exec.warmup_persistent_broker',
            new_callable=AsyncMock,
            return_value=None,
        ) as warmup,
        patch(
            'clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool',
            return_value=AsyncMock(ainvoke=AsyncMock(return_value='elevated ok')),
        ),
    ):
        note = await execute_pending_accept_command_decision(
            session,
            confirm=True,
            request_id='req-admin-tool',
        )
    assert note == 'elevated ok'
    assert session.admin_elevation_granted is True
    warmup.assert_awaited()


@pytest.mark.asyncio(loop_scope='function')
async def test_confirm_admin_elevation_tool_keeps_grant_off_when_helper_fails() -> None:
    session = get_session('deferred-hitl-admin-tool-fail')
    session.admin_elevation_granted = False
    session.pending_accept_command_request = {
        'request_id': 'req-admin-fail',
        'kind': ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
        'title': 'Grant administrator access',
        'message': 'm',
        'confirm_label': 'Allow',
        'cancel_label': 'Cancel',
        'command_text': '',
        'details': [],
        'cancel_note': 'declined',
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'apt update', 'elevate': True},
        },
    }
    with (
        patch(
            'clara_coder_backend.runtime.admin_exec.warmup_persistent_broker',
            new_callable=AsyncMock,
            return_value='User cancelled the administrator prompt.',
        ),
        patch(
            'clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool',
            return_value=AsyncMock(ainvoke=AsyncMock(return_value='should not run')),
        ) as resolve_mock,
    ):
        note = await execute_pending_accept_command_decision(
            session,
            confirm=True,
            request_id='req-admin-fail',
        )
    assert 'cancelled' in note.lower()
    assert session.admin_elevation_granted is False
    resolve_mock.assert_not_called()


@pytest.mark.asyncio(loop_scope='function')
async def test_confirm_session_grants_elevation_then_executes() -> None:
    session = get_session('deferred-hitl-confirm-session')
    session.admin_elevation_granted = False
    session.pending_accept_command_request = {
        'request_id': 'req-elev-session',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run administrator command',
        'message': 'm',
        'confirm_label': 'Allow once',
        'confirm_session_label': 'Allow for this session',
        'cancel_label': 'Cancel',
        'command_text': 'apt update',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'apt update', 'cwd': '.', 'elevate': True},
        },
    }
    with patch(
        'clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool',
        return_value=AsyncMock(ainvoke=AsyncMock(return_value='elevated ok')),
    ):
        note = await execute_pending_accept_command_decision(
            session,
            confirm=True,
            request_id='req-elev-session',
            grant_session=True,
        )
    assert note == 'elevated ok'
    assert session.admin_elevation_granted is True
    assert session.pending_accept_command_request is None


@pytest.mark.asyncio(loop_scope='function')
async def test_confirm_once_does_not_grant_session_elevation() -> None:
    session = get_session('deferred-hitl-confirm-once')
    session.admin_elevation_granted = False
    session.pending_accept_command_request = {
        'request_id': 'req-elev-once',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run administrator command',
        'message': 'm',
        'confirm_label': 'Allow once',
        'confirm_session_label': 'Allow for this session',
        'cancel_label': 'Cancel',
        'command_text': 'apt update',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'apt update', 'cwd': '.', 'elevate': True},
        },
    }
    with patch(
        'clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool',
        return_value=AsyncMock(ainvoke=AsyncMock(return_value='once ok')),
    ):
        note = await execute_pending_accept_command_decision(
            session,
            confirm=True,
            request_id='req-elev-once',
        )
    assert note == 'once ok'
    assert session.admin_elevation_granted is False


@pytest.mark.asyncio(loop_scope='function')
async def test_confirm_session_without_elevate_does_not_grant() -> None:
    session = get_session('deferred-hitl-session-no-elevate')
    session.admin_elevation_granted = False
    session.pending_accept_command_request = {
        'request_id': 'req-no-elev',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run terminal command',
        'message': 'm',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': 'echo hi',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {'tool_name': 'run_command', 'tool_input': {'command': 'echo hi', 'elevate': False}},
    }
    with patch(
        'clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool',
        return_value=AsyncMock(ainvoke=AsyncMock(return_value='ok')),
    ):
        await execute_pending_accept_command_decision(
            session,
            confirm=True,
            request_id='req-no-elev',
            grant_session=True,
        )
    assert session.admin_elevation_granted is False


@pytest.mark.asyncio(loop_scope='function')
async def test_cancel_elevated_command_does_not_grant_or_execute() -> None:
    session = get_session('deferred-hitl-cancel-elev')
    session.admin_elevation_granted = False
    session.pending_accept_command_request = {
        'request_id': 'req-elev-cancel',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run administrator command',
        'message': 'm',
        'confirm_label': 'Allow once',
        'cancel_label': 'Cancel',
        'command_text': 'apt update',
        'details': [],
        'cancel_note': 'User cancelled the pending command: Run administrator command.',
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'apt update', 'elevate': True},
        },
    }
    with patch(
        'clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool',
        return_value=AsyncMock(ainvoke=AsyncMock(return_value='should not run')),
    ) as resolve_mock:
        note = await execute_pending_accept_command_decision(
            session,
            confirm=False,
            request_id='req-elev-cancel',
        )
    resolve_mock.assert_not_called()
    assert 'cancelled' in note.lower()
    assert session.admin_elevation_granted is False
