"""Detached, serialized chat turns (``session.turns``): preempt, supersede, client-gone cleanup, carry-over."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest

from clara_coder_backend.lang_agent.streaming import sse_line
from clara_coder_backend.session import state
from clara_coder_backend.session.turns import serve_turn, session_turn_active, stop_session_turn

pytestmark = pytest.mark.asyncio(loop_scope='function')

SID = 'turns-session'


@pytest.fixture(autouse=True)
def _session():
    state.sessions.pop(SID, None)
    sess = state.get_session(SID)
    yield sess
    state.sessions.pop(SID, None)


def _journal(path: str) -> str:
    return sse_line({'type': 'file_journal', 'fileJournal': {'relativePath': path, 'userMessageId': 'u1'}})


def _turn(name: str, log: list[str], *, lines: list[str] | None = None, wait_for_abort: bool = False):
    """A stand-in composer turn: yields ``lines``, optionally waits until the session is aborted."""

    def make() -> AsyncIterator[str]:
        async def gen() -> AsyncIterator[str]:
            sess = state.sessions[SID]
            log.append(f'{name}:start')
            try:
                for line in lines or [sse_line({'type': 'chunk', 'delta': name})]:
                    yield line
                if wait_for_abort:
                    await sess.abort_event.wait()
                    log.append(f'{name}:aborted')
                    # Post-stream chores run after an abort too (they would be cancelled inside the request).
                    await asyncio.sleep(0.01)
                    for line in [_journal(f'{name}-late.txt'), sse_line({'type': 'chunk', 'delta': 'late'})]:
                        yield line
                    log.append(f'{name}:cleanup')
                yield 'data: [DONE]\n\n'
            finally:
                log.append(f'{name}:end')

        return gen()

    return make


async def _collect(relay: AsyncIterator[str]) -> list[str]:
    return [line async for line in relay]


def _deltas(lines: list[str]) -> list[str]:
    out = []
    for line in lines:
        body = line.removeprefix('data: ').strip()
        if body != '[DONE]':
            payload: dict[str, Any] = json.loads(body)
            out.append(payload.get('delta') or payload.get('fileJournal', {}).get('relativePath'))
    return out


async def test_a_new_turn_preempts_the_running_one_and_runs_after_it() -> None:
    log: list[str] = []
    first = asyncio.create_task(_collect(serve_turn(SID, _turn('a', log, wait_for_abort=True))))
    await asyncio.sleep(0.02)
    assert log == ['a:start']

    second_lines = await asyncio.wait_for(_collect(serve_turn(SID, _turn('b', log))), timeout=2)
    first_lines = await asyncio.wait_for(first, timeout=2)

    assert log == ['a:start', 'a:aborted', 'a:cleanup', 'a:end', 'b:start', 'b:end']
    assert _deltas(first_lines) == ['a', 'a-late.txt', 'late']
    assert _deltas(second_lines) == ['b']
    assert not session_turn_active(SID)


async def test_a_turn_replaced_before_it_started_is_recorded_not_run() -> None:
    log: list[str] = []
    superseded: list[str] = []
    first = asyncio.create_task(_collect(serve_turn(SID, _turn('a', log, wait_for_abort=True))))
    await asyncio.sleep(0.02)
    middle = asyncio.create_task(
        _collect(serve_turn(SID, _turn('b', log), on_superseded=lambda: superseded.append('b')))
    )
    await asyncio.sleep(0)
    last = await asyncio.wait_for(_collect(serve_turn(SID, _turn('c', log))), timeout=2)

    assert await asyncio.wait_for(middle, timeout=2) == ['data: [DONE]\n\n']
    await asyncio.wait_for(first, timeout=2)
    assert superseded == ['b']
    assert 'b:start' not in log and log[-2:] == ['c:start', 'c:end']
    assert _deltas(last) == ['c']


async def test_a_turn_whose_client_left_before_it_started_announces_waiting_reports(_session) -> None:
    """The turn it interrupted left the sub-agent reports to it; with no turn after it, they go out now."""
    from clara_coder_backend.lang_agent.subagent_bus import SUBAGENT_BUS
    from clara_coder_backend.lang_agent.subagents import SubagentReport
    from clara_coder_backend.routes.chat import chat_stream
    from clara_coder_backend.session.schemas import ChatRequest

    SUBAGENT_BUS.reset()
    log: list[str] = []
    try:
        first = asyncio.create_task(_collect(serve_turn(SID, _turn('a', log, wait_for_abort=True))))
        await asyncio.sleep(0.02)
        _session.subagent_pending_reports['c1'] = SubagentReport('c1', 'scout', 'r', 'completed')
        response = await chat_stream(ChatRequest(session_id=SID, message='second'))
        await response.body_iterator.aclose()  # Stop right after sending: the client leaves first
        await asyncio.wait_for(first, timeout=2)
        for _ in range(100):
            if SUBAGENT_BUS.buffered():
                break
            await asyncio.sleep(0.01)

        assert 'a:end' in log
        assert SUBAGENT_BUS.buffered() == [
            {'type': 'subagent_results_ready', 'parent_conversation_id': SID, 'names': ['scout']}
        ]
        assert _session.history[-2]['content'] == 'second'

        # A turn replaced by a stop (``/clear``, ``/load``) announces nothing: the route handles the reports.
        SUBAGENT_BUS.reset()
        _session.abort_event.clear()
        first = asyncio.create_task(_collect(serve_turn(SID, _turn('a', log, wait_for_abort=True))))
        await asyncio.sleep(0.02)
        response = await chat_stream(ChatRequest(session_id=SID, message='third'))
        relay = asyncio.create_task(_collect(response.body_iterator))
        await asyncio.sleep(0)
        await asyncio.wait_for(stop_session_turn(SID), timeout=2)
        await asyncio.wait_for(asyncio.gather(first, relay), timeout=2)
        assert SUBAGENT_BUS.buffered() == []
    finally:
        SUBAGENT_BUS.reset()


async def test_closing_the_relay_aborts_the_turn_and_its_cleanup_still_runs(_session) -> None:
    log: list[str] = []
    relay = serve_turn(SID, _turn('a', log, wait_for_abort=True))
    first = await relay.__anext__()
    assert _deltas([first]) == ['a']

    # The client went away: only the relay is closed; the turn is aborted and winds down on its own.
    await relay.aclose()
    assert _session.abort_event.is_set()
    for _ in range(100):
        if 'a:end' in log:
            break
        await asyncio.sleep(0.01)
    assert log == ['a:start', 'a:aborted', 'a:cleanup', 'a:end']

    # Its journal row reaches the next stream first; its other late lines are dropped.
    log.clear()
    _session.abort_event.clear()
    nxt = await asyncio.wait_for(_collect(serve_turn(SID, _turn('b', log))), timeout=2)
    assert _deltas(nxt) == ['a-late.txt', 'b']


async def test_stop_session_turn_waits_for_the_turn_and_drops_waiting_ones() -> None:
    log: list[str] = []
    superseded: list[str] = []
    first = asyncio.create_task(_collect(serve_turn(SID, _turn('a', log, wait_for_abort=True))))
    await asyncio.sleep(0.02)
    second = asyncio.create_task(
        _collect(serve_turn(SID, _turn('b', log), on_superseded=lambda: superseded.append('b')))
    )
    await asyncio.sleep(0)
    # ``b`` is queued behind ``a``; stopping the session must wait for ``a`` and drop ``b``.
    await asyncio.wait_for(stop_session_turn(SID), timeout=2)

    assert 'a:end' in log and 'b:start' not in log
    assert superseded == ['b']
    assert not session_turn_active(SID)
    await asyncio.wait_for(asyncio.gather(first, second), timeout=2)


async def test_clear_route_stops_the_running_turn_before_resetting(_session) -> None:
    from clara_coder_backend.routes.session import clear_session
    from clara_coder_backend.session.schemas import ClearRequest

    log: list[str] = []
    turn = asyncio.create_task(_collect(serve_turn(SID, _turn('a', log, wait_for_abort=True))))
    await asyncio.sleep(0.02)

    await asyncio.wait_for(clear_session(ClearRequest(session_id=SID)), timeout=5)

    assert log[-1] == 'a:end'
    assert state.sessions[SID] is not _session
    await asyncio.wait_for(turn, timeout=2)


async def test_chat_stream_rejects_subagent_ids() -> None:
    from fastapi import HTTPException

    from clara_coder_backend.lang_agent.subagents import fork_subagent_session
    from clara_coder_backend.routes.chat import chat_stream
    from clara_coder_backend.session.schemas import ChatRequest

    fork_subagent_session(SID, state.sessions[SID], 'turns-child-1', 'x')
    try:
        with pytest.raises(HTTPException) as exc:
            await chat_stream(ChatRequest(session_id='turns-child-1', message='hi'))
        assert exc.value.status_code == 400
    finally:
        state.sessions.pop('turns-child-1', None)


async def test_chat_stream_relays_the_detached_composer_turn(_session) -> None:
    from unittest.mock import MagicMock, patch

    from clara_coder_backend.routes.chat import chat_stream
    from clara_coder_backend.session.schemas import ChatRequest

    async def _fake_stream(session: Any, *_args: Any, **kwargs: Any):
        kwargs['outcome'].mark_completed(final_text='Hi there.', partial_text='Hi there.')
        yield sse_line({'type': 'chunk', 'delta': 'Hi there.'})

    with (
        patch('clara_coder_backend.composer.build_llm', return_value=MagicMock()),
        patch('clara_coder_backend.composer.stream_single_agent_langgraph', side_effect=_fake_stream),
        patch('clara_coder_backend.composer.maybe_compact_outer_checkpoint', return_value=None),
    ):
        response = await chat_stream(ChatRequest(session_id=SID, message='hello'))
        lines = [line async for line in response.body_iterator]

    assert lines[-1] == 'data: [DONE]\n\n'
    assert {'type': 'final_text', 'text': 'Hi there.'} in [
        json.loads(line.removeprefix('data: ')) for line in lines[:-1]
    ]
    assert _session.history[-1] == {'role': 'assistant', 'content': 'Hi there.'}


async def test_a_client_disconnect_aborts_the_detached_turn_through_the_response(_session) -> None:
    """Starlette never closes the body iterator: the response itself must tell the turn its client left."""
    from starlette.requests import ClientDisconnect

    from clara_coder_backend.routes.chat import _TurnStreamingResponse

    log: list[str] = []
    response = _TurnStreamingResponse(serve_turn(SID, _turn('a', log, wait_for_abort=True)), media_type='text/event-stream')
    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        if message['type'] == 'http.response.body' and sent:
            raise OSError('connection lost')  # what an ASGI 2.4 server raises once the peer is gone
        sent.append(message)

    async def receive() -> dict[str, Any]:
        await asyncio.Future()
        return {}

    with pytest.raises(ClientDisconnect):
        await response({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, send)

    assert _session.abort_event.is_set()
    for _ in range(100):
        if 'a:end' in log:
            break
        await asyncio.sleep(0.01)
    assert log == ['a:start', 'a:aborted', 'a:cleanup', 'a:end']


async def test_a_non_preempting_turn_queues_behind_the_running_one() -> None:
    """A continue-with-sub-agent-results turn never interrupts the user's turn; it runs after it."""
    log: list[str] = []
    first = asyncio.create_task(_collect(serve_turn(SID, _turn('a', log, wait_for_abort=True))))
    await asyncio.sleep(0.02)
    second = asyncio.create_task(_collect(serve_turn(SID, _turn('b', log), preempt=False)))
    await asyncio.sleep(0.05)
    assert log == ['a:start'] and not state.sessions[SID].abort_event.is_set()

    state.sessions[SID].abort_event.set()  # ``a`` ends on its own terms
    await asyncio.wait_for(asyncio.gather(first, second), timeout=2)
    assert log == ['a:start', 'a:aborted', 'a:cleanup', 'a:end', 'b:start', 'b:end']


async def test_session_turn_pending_can_leave_out_the_calling_turn() -> None:
    from clara_coder_backend.session.turns import session_turn_pending

    seen: list[tuple[str, bool]] = []
    gate = asyncio.Event()

    def make(name: str):
        def factory() -> AsyncIterator[str]:
            async def gen() -> AsyncIterator[str]:
                if name == 'a':
                    await gate.wait()
                seen.append((name, session_turn_pending(SID, exclude_current=True)))
                yield 'data: [DONE]\n\n'

            return gen()

        return factory

    first = asyncio.create_task(_collect(serve_turn(SID, make('a'))))
    await asyncio.sleep(0.02)
    second = asyncio.create_task(_collect(serve_turn(SID, make('b'), preempt=False)))
    await asyncio.sleep(0.02)
    assert session_turn_pending(SID)
    gate.set()
    await asyncio.wait_for(asyncio.gather(first, second), timeout=2)
    # ``a`` saw ``b`` waiting behind it; ``b`` ran alone.
    assert seen == [('a', True), ('b', False)]
    assert not session_turn_pending(SID)
