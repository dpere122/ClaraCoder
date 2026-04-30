"""Tests for :mod:`nemo_backend.accept_command_review_middleware`."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import ToolMessage

from nemo_backend.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from nemo_backend.python_dependency_agent import INSTALL_PYTHON_PACKAGES_NAME
from nemo_backend.state import current_session_id, get_session

pytestmark = pytest.mark.asyncio(loop_scope='function')


@patch('nemo_backend.accept_command_review_middleware.await_diff_review_note', new_callable=AsyncMock)
async def test_middleware_queues_accept_command_when_hitl_queue_set_even_if_worker_apply_off(
    mock_pause: AsyncMock,
) -> None:
    """Regression: npm/pip HITL must not depend on ``worker_apply_mode`` (editor-only flag)."""
    mock_pause.return_value = ''

    session_id = 'accept-cmd-mw-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = False
    session.auto_apply_mode = False
    session.hitl_sse_queue = asyncio.Queue()
    session.pending_accept_command_request = {
        'request_id': 'req-1',
        'kind': 'python_dependency',
        'title': 'Install Python packages',
        'message': 'm',
        'confirm_label': 'Install',
        'cancel_label': 'Cancel',
        'command_text': 'pip install pytest',
        'details': [],
        'cancel_note': 'cancelled',
        'action': {},
    }

    mw = AcceptCommandReviewAfterToolMiddleware()

    async def _handler(_req: object) -> ToolMessage:
        return ToolMessage(
            content='Pending user confirmation…',
            tool_call_id='tc-1',
            name=INSTALL_PYTHON_PACKAGES_NAME,
        )

    request = SimpleNamespace(
        tool_call={'name': INSTALL_PYTHON_PACKAGES_NAME, 'id': 'tc-1'},
    )
    try:
        await mw.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    item = await asyncio.wait_for(session.hitl_sse_queue.get(), timeout=1.0)
    assert item == ('accept_command',)
