"""Tests for :mod:`clara_coder_backend.middleware.accept_command_review_middleware`."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import ToolMessage

from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL
from clara_coder_backend.middleware.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from clara_coder_backend.session.state import current_session_id, get_session

pytestmark = pytest.mark.asyncio(loop_scope='function')


@patch('clara_coder_backend.middleware.accept_command_review_middleware.await_diff_review_note', new_callable=AsyncMock)
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
    session.pending_accept_command_request = {
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

    item = await asyncio.wait_for(session.hitl_sse_queue.get(), timeout=1.0)
    assert item == ('accept_command',)


@patch('clara_coder_backend.middleware.accept_command_review_middleware.await_diff_review_note', new_callable=AsyncMock)
async def test_middleware_queues_accept_command_for_staging_overlay_when_auto_apply_off(
    mock_pause: AsyncMock,
) -> None:
    """run_staging_overlay_command must pause like other deferred execute tools when auto-apply is off."""
    mock_pause.return_value = ''

    session_id = 'accept-cmd-overlay-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = True
    session.auto_apply_mode = False
    session.hitl_sse_queue = asyncio.Queue()
    session.pending_accept_command_request = {
        'request_id': 'req-overlay',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run staging overlay command',
        'message': 'Execute a command in the staging overlay.',
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

    mw = AcceptCommandReviewAfterToolMiddleware()

    async def _handler(_req: object) -> ToolMessage:
        return ToolMessage(
            content='Pending user confirmation…',
            tool_call_id='tc-overlay',
            name='run_staging_overlay_command',
        )

    request = SimpleNamespace(
        tool_call={'name': 'run_staging_overlay_command', 'id': 'tc-overlay'},
    )
    try:
        await mw.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    item = await asyncio.wait_for(session.hitl_sse_queue.get(), timeout=1.0)
    assert item == ('accept_command',)
