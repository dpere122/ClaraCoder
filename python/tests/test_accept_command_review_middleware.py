"""Tests for :mod:`clara_coder_backend.middleware.accept_command_review_middleware`."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import ToolMessage

from clara_coder_backend.hitl.accept_command import (
    ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
    ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
)
from clara_coder_backend.middleware.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from clara_coder_backend.session.pause import stage_hitl_request
from clara_coder_backend.session.state import current_session_id, get_session

pytestmark = pytest.mark.asyncio(loop_scope='function')


@patch('clara_coder_backend.middleware.accept_command_review_middleware.pause_for_tool_review', new_callable=AsyncMock)
async def test_middleware_queues_accept_command_when_hitl_queue_set_even_if_worker_apply_off(
    mock_pause: AsyncMock,
) -> None:
    """Regression: deferred execute HITL must not depend on ``worker_apply_mode`` (editor-only flag)."""
    mock_pause.return_value = ''

    session_id = 'accept-cmd-mw-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = False
    session.auto_apply_mode = False
    session.hitl_sse_queue = asyncio.Queue()
    pending = {
        'request_id': 'req-1',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run terminal command',
        'message': 'm',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': 'ls -la',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'ls -la', 'cwd': '.'},
        },
    }

    mw = AcceptCommandReviewAfterToolMiddleware()

    async def _handler(_req: object) -> ToolMessage:
        stage_hitl_request(session, 'pending_accept_command_request', pending)
        return ToolMessage(
            content='Pending user confirmation…',
            tool_call_id='tc-1',
            name='run_command',
        )

    request = SimpleNamespace(
        tool_call={'name': 'run_command', 'id': 'tc-1'},
    )
    try:
        await mw.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    mock_pause.assert_awaited_once_with(
        session_id, ('accept_command',), {'pending_accept_command_request': pending}
    )


@patch('clara_coder_backend.middleware.accept_command_review_middleware.pause_for_tool_review', new_callable=AsyncMock)
async def test_middleware_queues_admin_elevation_when_auto_apply_on(
    mock_pause: AsyncMock,
) -> None:
    """Agent-requested Admin grant must still pause the composer chip under auto-apply."""
    mock_pause.return_value = ''

    session_id = 'accept-cmd-admin-auto'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    session.admin_elevation_granted = False
    session.hitl_sse_queue = asyncio.Queue()
    pending = {
        'request_id': 'req-admin-auto',
        'kind': ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
        'title': 'Grant administrator access',
        'message': 'Allow this agent to run shell commands with administrator privileges.',
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

    mw = AcceptCommandReviewAfterToolMiddleware()

    async def _handler(_req: object) -> ToolMessage:
        stage_hitl_request(session, 'pending_accept_command_request', pending)
        return ToolMessage(
            content='Pending user confirmation for administrator access.',
            tool_call_id='tc-admin-auto',
            name='run_command',
        )

    request = SimpleNamespace(
        tool_call={'name': 'run_command', 'id': 'tc-admin-auto'},
    )
    try:
        await mw.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    mock_pause.assert_awaited_once_with(
        session_id, ('accept_command',), {'pending_accept_command_request': pending}
    )


@patch('clara_coder_backend.middleware.accept_command_review_middleware.pause_for_tool_review', new_callable=AsyncMock)
async def test_middleware_skips_when_auto_apply_on_and_no_pending(
    mock_pause: AsyncMock,
) -> None:
    """Ordinary execute tools still run immediately under auto-apply when nothing is staged."""
    session_id = 'accept-cmd-auto-no-pending'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = True
    session.auto_apply_mode = True
    session.hitl_sse_queue = asyncio.Queue()
    session.pending_accept_command_request = None

    mw = AcceptCommandReviewAfterToolMiddleware()

    async def _handler(_req: object) -> ToolMessage:
        return ToolMessage(content='ok', tool_call_id='tc-auto', name='run_command')

    request = SimpleNamespace(tool_call={'name': 'run_command', 'id': 'tc-auto'})
    try:
        result = await mw.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    assert result.content == 'ok'
    mock_pause.assert_not_awaited()
    assert session.hitl_sse_queue.empty()
