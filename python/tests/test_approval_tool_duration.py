"""An approval-gated call reports how long it ran, never how long its card waited for the user."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import pytest
from langchain_core.messages import ToolMessage

from clara_coder_backend.hitl.accept_command import execute_pending_accept_command_decision
from clara_coder_backend.lang_agent.langgraph_sse import (
    GraphStreamState,
    approval_answer_sse_lines,
    sse_lines_for_graph_event,
)
from clara_coder_backend.session.pause import pause_for_tool_review, timed_approved_run
from clara_coder_backend.session.state import get_session
from clara_coder_backend.tools.deferred_hitl import ACCEPT_COMMAND_KIND_DEFERRED_TOOL

PENDING = 'Pending user confirmation for `fetch_url`. The UI will ask the user to confirm before this command runs.'
CLOCK = 'clara_coder_backend.lang_agent.langgraph_sse.time.monotonic'


def _run(ev: dict, state: GraphStreamState) -> list[str]:
    return list(sse_lines_for_graph_event(ev, state, agent_role=None, status_label='', llm_event_prefix='', llm_log_context=''))


def _status(lines: list[str]) -> dict:
    rows = [json.loads(line.removeprefix('data: ')) for line in lines]
    return next(r['status'] for r in rows if r.get('type') == 'status')


def _start(run_id: str) -> dict:
    return {'event': 'on_tool_start', 'name': 'fetch_url', 'run_id': run_id, 'data': {'input': {'url': 'https://example.com'}}}


def _end(run_id: str, text: str, call_id: str) -> dict:
    return {
        'event': 'on_tool_end',
        'name': 'fetch_url',
        'run_id': run_id,
        'data': {'output': ToolMessage(content=text, tool_call_id=call_id)},
    }


def test_pending_call_gets_its_time_from_the_answer() -> None:
    state = GraphStreamState()
    with patch(CLOCK, side_effect=[10.0, 10.004]):
        _run(_start('r1'), state)
        pending = _status(_run(_end('r1', PENDING, 'c1'), state))
    assert pending['detail'].startswith('Pending user confirmation')
    assert 'duration_ms' not in pending

    done = _status(
        approval_answer_sse_lines(
            {'tool_call_id': 'c1', 'text': 'Fetched https://example.com', 'duration_ms': 830}, states=[state]
        )
    )
    assert done['id'] == pending['id']
    assert done['state'] == 'complete'
    assert done['detail'] == 'Fetched https://example.com'
    # 4 ms staging the card + 830 ms fetching; the wait for the user is not counted.
    assert done['duration_ms'] == 834
    assert state.awaiting_approval_calls == {}


def test_cancelled_call_has_no_time() -> None:
    state = GraphStreamState()
    _run(_start('r2'), state)
    _run(_end('r2', PENDING, 'c2'), state)
    done = _status(
        approval_answer_sse_lines(
            {'tool_call_id': 'c2', 'text': 'User cancelled the pending command: Fetch URL.', 'duration_ms': None},
            states=[state],
        )
    )
    assert done['detail'] == 'User cancelled the pending command: Fetch URL.'
    assert 'duration_ms' not in done


def test_an_answer_that_beats_the_tool_event_is_used_when_it_ends() -> None:
    state = GraphStreamState()
    with patch(CLOCK, side_effect=[1.0, 1.002]):
        _run(_start('r3'), state)
        assert approval_answer_sse_lines({'tool_call_id': 'c3', 'text': 'Fetched', 'duration_ms': 40}, states=[state]) == []
        done = _status(_run(_end('r3', PENDING, 'c3'), state))
    assert done['detail'] == 'Fetched'
    assert done['duration_ms'] == 42
    assert state.early_approval_answers == {}
    assert state.awaiting_approval_calls == {}


def test_a_nested_call_is_found_after_the_outer_state() -> None:
    outer = GraphStreamState()
    nested = GraphStreamState(early_approval_answers=outer.early_approval_answers)
    _run(_start('r4'), nested)
    pending = _status(_run(_end('r4', PENDING, 'c4'), nested))
    done = _status(approval_answer_sse_lines({'tool_call_id': 'c4', 'text': 'Fetched', 'duration_ms': 7}, states=[outer, nested]))
    assert done['id'] == pending['id']


def test_calls_that_ran_right_away_keep_their_own_time() -> None:
    state = GraphStreamState()
    with patch(CLOCK, side_effect=[3.0, 3.25]):
        _run(_start('r5'), state)
        done = _status(_run(_end('r5', 'Fetched https://example.com', 'c5'), state))
    assert done['duration_ms'] == 250
    assert state.awaiting_approval_calls == {}


@pytest.mark.asyncio(loop_scope='function')
async def test_pause_reports_only_the_approved_run_time() -> None:
    session_id = 'approval-duration-session'
    session = get_session(session_id)
    session.hitl_sse_queue = asyncio.Queue()

    async def answer() -> None:
        assert await session.hitl_sse_queue.get() == ('accept_command',)
        await asyncio.sleep(0.05)  # The user reads the card.
        with patch('clara_coder_backend.session.pause.time.monotonic', side_effect=[50.0, 50.125]):
            with timed_approved_run(session):
                pass
        session.agent_pause_note = 'Fetched https://example.com'
        session.agent_pause_event.set()

    task = asyncio.create_task(answer())
    note = await pause_for_tool_review(session_id, ('accept_command',), {}, tool_call_id='c9')
    await task

    assert note == 'Fetched https://example.com'
    assert session.hitl_sse_queue.get_nowait() == (
        'tool_resolved',
        {'tool_call_id': 'c9', 'text': 'Fetched https://example.com', 'duration_ms': 125},
    )
    assert session.agent_pause_run_ms is None
    session.hitl_sse_queue = None


class _FakeFetch:
    async def ainvoke(self, _tool_input: dict) -> str:
        await asyncio.sleep(0.02)
        return 'Fetched https://example.com'


def _deferred_fetch() -> dict:
    return {
        'request_id': 'req-fetch',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'cancel_note': 'User cancelled the pending command: Fetch URL.',
        'action': {'tool_name': 'fetch_url', 'tool_input': {'url': 'https://example.com'}},
    }


@pytest.mark.asyncio(loop_scope='function')
async def test_approved_deferred_tool_times_its_run() -> None:
    session = get_session('approval-duration-run')
    session.agent_pause_run_ms = None
    session.pending_accept_command_request = _deferred_fetch()
    with patch('clara_coder_backend.hitl.deferred_tool_hitl._resolve_deferred_tool', return_value=_FakeFetch()):
        out = await execute_pending_accept_command_decision(session, confirm=True, request_id='req-fetch')
    assert out == 'Fetched https://example.com'
    assert session.agent_pause_run_ms is not None and session.agent_pause_run_ms >= 15


@pytest.mark.asyncio(loop_scope='function')
async def test_cancelled_deferred_tool_runs_nothing() -> None:
    session = get_session('approval-duration-cancel')
    session.agent_pause_run_ms = None
    session.pending_accept_command_request = _deferred_fetch()
    out = await execute_pending_accept_command_decision(session, confirm=False, request_id='req-fetch')
    assert out == 'User cancelled the pending command: Fetch URL.'
    assert session.agent_pause_run_ms is None
