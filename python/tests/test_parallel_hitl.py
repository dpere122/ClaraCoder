"""Review cards from parallel tool calls: one card at a time, each answer resumes its own call."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import ToolMessage

from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL
from clara_coder_backend.middleware.accept_command_review_middleware import AcceptCommandReviewAfterToolMiddleware
from clara_coder_backend.middleware.delete_review_middleware import DeleteReviewAfterToolMiddleware
from clara_coder_backend.routes.chat import agent_continue
from clara_coder_backend.session.pause import hitl_tool_call_scope, stage_hitl_request
from clara_coder_backend.session.schemas import AgentContinueRequest
from clara_coder_backend.session.state import current_session_id, get_session

pytestmark = pytest.mark.asyncio(loop_scope='function')


def _command(call_id: str) -> dict[str, Any]:
    return {
        'request_id': f'req-{call_id}',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': f'Run {call_id}',
        'message': 'm',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': f'echo {call_id}',
        'details': [],
        'cancel_note': f'cancelled {call_id}',
        'action': {'tool_name': 'run_command', 'tool_input': {'command': f'echo {call_id}'}},
    }


async def _answer_cards(session_id: str, count: int, slot: str, answer: dict[str, Any]) -> list[str]:
    """Stand-in for the UI: answer each card the stream emits, in order, via agent-continue."""

    sess = get_session(session_id)
    shown: list[str] = []
    for _ in range(count):
        await asyncio.wait_for(sess.hitl_sse_queue.get(), timeout=2)
        request_id = getattr(sess, slot)['request_id']
        shown.append(request_id)
        reply = await agent_continue(AgentContinueRequest(session_id=session_id, **answer(request_id)))
        assert reply['ok'] is True
    return shown


async def test_scope_is_shared_by_one_calls_middlewares_and_separate_per_call() -> None:
    async def call(key: str, value: str) -> dict[str, Any]:
        with hitl_tool_call_scope(key) as outer, hitl_tool_call_scope(key) as inner:
            assert outer is inner
            stage_hitl_request(object(), 'pending_copy_request', value)
            await asyncio.sleep(0)
            return dict(outer)

    a, b = await asyncio.gather(call('a', 'from-a'), call('b', 'from-b'))
    assert a == {'pending_copy_request': 'from-a'}
    assert b == {'pending_copy_request': 'from-b'}

    session = SimpleNamespace(pending_copy_request=None)
    stage_hitl_request(session, 'pending_copy_request', 'direct')
    assert session.pending_copy_request == 'direct'


async def test_parallel_accept_command_cards_each_resume_their_own_call() -> None:
    session_id = 'parallel-accept-cards'
    session = get_session(session_id)
    session.worker_apply_mode = False
    session.auto_apply_mode = False
    session.pending_accept_command_request = None
    session.hitl_sse_queue = asyncio.Queue()
    mw = AcceptCommandReviewAfterToolMiddleware()

    async def call(call_id: str) -> ToolMessage:
        async def handler(_req: object) -> ToolMessage:
            stage_hitl_request(session, 'pending_accept_command_request', _command(call_id))
            await asyncio.sleep(0)  # let the other call stage before this one's card is shown
            return ToolMessage(content=f'pending {call_id}', tool_call_id=call_id, name='run_command')

        request = SimpleNamespace(tool_call={'name': 'run_command', 'id': call_id})
        return await mw.awrap_tool_call(request, handler)

    token = current_session_id.set(session_id)
    try:
        results = await asyncio.gather(
            call('a'),
            call('b'),
            _answer_cards(
                session_id,
                2,
                'pending_accept_command_request',
                lambda rid: {'accept_command_action': 'cancel', 'accept_command_request_id': rid},
            ),
        )
    finally:
        current_session_id.reset(token)
        session.hitl_sse_queue = None

    first, second, shown = results
    assert sorted(shown) == ['req-a', 'req-b']
    assert 'cancelled a' in str(first.content) and 'cancelled b' not in str(first.content)
    assert 'cancelled b' in str(second.content) and 'cancelled a' not in str(second.content)
    assert session.pending_accept_command_request is None


async def test_parallel_delete_cards_are_shown_one_at_a_time() -> None:
    session_id = 'parallel-delete-cards'
    session = get_session(session_id)
    session.worker_apply_mode = True
    session.auto_apply_mode = False
    session.pending_delete_request = None
    session.hitl_sse_queue = asyncio.Queue()
    mw = DeleteReviewAfterToolMiddleware()

    async def call(call_id: str) -> ToolMessage:
        async def handler(_req: object) -> ToolMessage:
            stage_hitl_request(
                session,
                'pending_delete_request',
                {'request_id': f'req-{call_id}', 'relative_path': f'{call_id}.txt', 'kind': 'file'},
            )
            await asyncio.sleep(0)
            return ToolMessage(content=f'pending {call_id}', tool_call_id=call_id, name='delete_workspace_entries')

        request = SimpleNamespace(tool_call={'name': 'delete_workspace_entries', 'id': call_id})
        return await mw.awrap_tool_call(request, handler)

    token = current_session_id.set(session_id)
    try:
        *_, shown = await asyncio.gather(
            call('a'),
            call('b'),
            _answer_cards(
                session_id,
                2,
                'pending_delete_request',
                lambda rid: {'delete_action': 'cancel', 'delete_request_id': rid},
            ),
        )
    finally:
        current_session_id.reset(token)
        session.hitl_sse_queue = None

    assert sorted(shown) == ['req-a', 'req-b']
    assert session.pending_delete_request is None


async def test_stale_answer_leaves_the_waiting_card_alone() -> None:
    session_id = 'stale-accept-answer'
    session = get_session(session_id)
    waiting = _command('b')
    session.pending_accept_command_request = waiting
    event = asyncio.Event()
    session.agent_pause_event = event
    try:
        reply = await agent_continue(
            AgentContinueRequest(
                session_id=session_id, accept_command_action='confirm', accept_command_request_id='req-a'
            )
        )
        assert reply['ok'] is False
        assert session.pending_accept_command_request is waiting
        assert not event.is_set()
    finally:
        session.pending_accept_command_request = None
        session.agent_pause_event = None
