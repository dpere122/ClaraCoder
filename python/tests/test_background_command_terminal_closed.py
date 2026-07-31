"""Background command terminal tab close route and streaming helpers."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import pytest

from clara_coder_backend.lang_agent.langgraph_sse import sse_lines_for_graph_event, GraphStreamState
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.tools.run_command import (
    RUN_COMMAND_STREAM_TAG_PREFIX,
    background_command_jobs,
    handle_background_command_terminal_closed,
    kill_session_background_commands,
    run_command_tool,
)
from clara_coder_backend.chat.user_events import drain_user_event_notes


@pytest.fixture()
def command_session():
    session_id = 'bg-cmd-tab-close-session'
    token = current_session_id.set(session_id)
    session = get_session(session_id)
    with tempfile.TemporaryDirectory() as td:
        session.workspace_path = str(Path(td).resolve())
        session.worker_apply_mode = True
        session.auto_apply_mode = True
        session.pending_accept_command_request = None
        session.planning_nested_events_q = asyncio.Queue()
        try:
            yield session
        finally:
            current_session_id.reset(token)


@pytest.mark.asyncio(loop_scope='function')
async def test_run_command_emits_open_and_chunk_events(command_session) -> None:
    session_id = 'bg-cmd-tab-close-session'
    try:
        task = asyncio.create_task(
            run_command_tool.ainvoke({'command': 'echo stream-me', 'wait_seconds': 15}),
        )
        open_item = await asyncio.wait_for(command_session.planning_nested_events_q.get(), timeout=5)
        assert open_item[1]['event'] == 'background_command_open'
        open_data = open_item[1]['data']
        command_id = open_data['command_id']
        assert command_id
        assert open_data['command_text'] == 'echo stream-me'
        assert open_data['stream_tag'] == f'{RUN_COMMAND_STREAM_TAG_PREFIX}{command_id}'

        chunk_item = await asyncio.wait_for(command_session.planning_nested_events_q.get(), timeout=5)
        assert chunk_item[1]['event'] == 'tool_exec_chunk'
        assert 'stream-me' in chunk_item[1]['data']['delta']

        await task
        complete_item = await asyncio.wait_for(command_session.planning_nested_events_q.get(), timeout=5)
        assert complete_item[1]['event'] == 'tool_exec_complete'
        assert complete_item[1]['data']['exit_code'] == 0
    finally:
        await kill_session_background_commands(session_id)


def test_background_command_open_sse_is_forwarded() -> None:
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'background_command_open',
            'data': {
                'command_id': 'abc12345',
                'command_text': 'npm run dev',
                'cwd_label': '.',
                'label': 'npm run dev',
                'stream_tag': 'run-command:abc12345',
            },
        },
        state,
        agent_role=None,
        status_label='Workspace',
        llm_event_prefix='nest',
        llm_log_context='test',
        stream_tag='run-command:abc12345',
    )
    assert len(lines) == 1
    assert '"type": "background_command_open"' in lines[0]
    assert '"command_id": "abc12345"' in lines[0]


@pytest.mark.asyncio(loop_scope='function')
async def test_terminal_closed_kills_running_job_and_queues_note(command_session) -> None:
    session_id = 'bg-cmd-tab-close-session'
    try:
        out = await run_command_tool.ainvoke({'command': 'sleep 60', 'wait_seconds': 0})
        assert 'still running' in out
        jobs = [j for j in background_command_jobs().values() if j.session_id == session_id]
        assert len(jobs) == 1
        command_id = jobs[0].job_id

        ok, note = await handle_background_command_terminal_closed(session_id, command_id)
        assert ok is True
        assert command_id in note
        assert 'closed the terminal tab' in note
        assert command_id not in background_command_jobs()
        queued = drain_user_event_notes(command_session)
        assert len(queued) == 1
        assert 'closed the terminal tab' in queued[0]
    finally:
        await kill_session_background_commands(session_id)


@pytest.mark.asyncio(loop_scope='function')
async def test_terminal_closed_unknown_command_still_queues_note() -> None:
    session_id = 'unknown-command-session'
    session = get_session(session_id)
    ok, note = await handle_background_command_terminal_closed(session_id, 'deadbeef')
    assert ok is True
    assert 'no longer tracked' in note
    assert drain_user_event_notes(session) == [note]
