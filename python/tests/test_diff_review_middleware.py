"""Tests for :mod:`nemo_backend.diff_review_middleware`."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import ToolMessage

from nemo_backend.agents.specialists.review_tools import TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME
from nemo_backend.diff_review_middleware import DiffReviewAfterToolMiddleware
from nemo_backend.state import current_session_id, get_session

pytestmark = pytest.mark.asyncio(loop_scope='function')


@patch('nemo_backend.diff_review_middleware.await_diff_review_note', new_callable=AsyncMock)
async def test_middleware_queues_diff_with_payload_when_hitl_queue_set_even_if_worker_apply_off(
    mock_pause: AsyncMock,
) -> None:
    """Regression: staged-transfer diff HITL must not depend on ``worker_apply_mode``."""
    mock_pause.return_value = ''

    session_id = 'diff-mw-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = False
    session.auto_apply_mode = False
    session.hitl_sse_queue = asyncio.Queue()
    payload = {
        'version': 1,
        'relativePath': 'a.py',
        'rows': [],
        'fullNewContent': 'x = 1\n',
        'truncated': False,
        'stagedTransferHitl': True,
    }
    session.pending_diff_payload = payload

    mw = DiffReviewAfterToolMiddleware()

    async def _handler(_req: object) -> ToolMessage:
        return ToolMessage(
            content='Awaiting human confirmation…',
            tool_call_id='tc-1',
            name=TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME,
        )

    request = SimpleNamespace(
        tool_call={'name': TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME, 'id': 'tc-1'},
    )
    try:
        await mw.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    item = await asyncio.wait_for(session.hitl_sse_queue.get(), timeout=1.0)
    assert item == ('diff', payload)


@patch('nemo_backend.diff_review_middleware.await_diff_review_note', new_callable=AsyncMock)
async def test_middleware_queues_staged_transfer_when_direct_mode_tool_set(mock_pause: AsyncMock) -> None:
    """Plan mode binds direct mutators but staged transfer HITL still pauses when flagged."""
    mock_pause.return_value = ''

    session_id = 'diff-mw-direct-transfer'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    session.worker_apply_mode = True
    session.auto_apply_mode = False
    session.hitl_sse_queue = asyncio.Queue()
    from nemo_backend.domain import PendingStagedTransferHitl

    session.pending_staged_transfer_hitl = PendingStagedTransferHitl(relative_path='a.py')
    payload = {
        'version': 1,
        'relativePath': 'a.py',
        'rows': [],
        'fullNewContent': 'x = 1\n',
        'truncated': False,
        'stagedTransferHitl': True,
    }
    session.pending_diff_payload = payload

    mw = DiffReviewAfterToolMiddleware()

    async def _handler(_req: object) -> ToolMessage:
        return ToolMessage(
            content='Awaiting human confirmation…',
            tool_call_id='tc-2',
            name=TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME,
        )

    request = SimpleNamespace(
        tool_call={'name': TRANSFER_STAGED_FILE_TO_WORKSPACE_NAME, 'id': 'tc-2'},
    )
    try:
        await mw.awrap_tool_call(request, _handler)
    finally:
        current_session_id.reset(token)

    item = await asyncio.wait_for(session.hitl_sse_queue.get(), timeout=1.0)
    assert item == ('diff', payload)
