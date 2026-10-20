"""Each finished tool status carries how long the call ran."""

from __future__ import annotations

import json
from unittest.mock import patch

from langchain_core.messages import ToolMessage

from clara_coder_backend.lang_agent.langgraph_sse import GraphStreamState, sse_lines_for_graph_event


def _run(ev: dict, state: GraphStreamState) -> list[dict]:
    lines = sse_lines_for_graph_event(ev, state, agent_role=None, status_label='', llm_event_prefix='', llm_log_context='')
    return [json.loads(line.removeprefix('data: ')) for line in lines]


def _status(rows: list[dict]) -> dict:
    return next(r['status'] for r in rows if r.get('type') == 'status')


def _start(run_id: str) -> dict:
    return {'event': 'on_tool_start', 'name': 'read_workspace_file', 'run_id': run_id, 'data': {'input': {'relative_path': 'a.py'}}}


def _end(run_id: str, output: object) -> dict:
    return {'event': 'on_tool_end', 'name': 'read_workspace_file', 'run_id': run_id, 'data': {'output': output}}


def test_finished_status_carries_the_run_time() -> None:
    state = GraphStreamState()
    with patch('clara_coder_backend.lang_agent.langgraph_sse.time.monotonic', side_effect=[100.0, 101.2345]):
        running = _status(_run(_start('r1'), state))
        done = _status(_run(_end('r1', ToolMessage(content='File: a.py', tool_call_id='c1')), state))
    assert 'duration_ms' not in running
    assert done['state'] == 'complete'
    assert done['duration_ms'] == 1234
    assert state.tool_started_at == {}


def test_failed_calls_carry_it_too() -> None:
    state = GraphStreamState()
    with patch('clara_coder_backend.lang_agent.langgraph_sse.time.monotonic', side_effect=[5.0, 5.05]):
        _run(_start('r2'), state)
        done = _status(_run(_end('r2', RuntimeError('boom')), state))
    assert done['state'] == 'error'
    assert done['duration_ms'] == 50


def test_a_run_whose_start_was_not_seen_has_no_duration() -> None:
    done = _status(_run(_end('r3', 'ok'), GraphStreamState()))
    assert done['state'] == 'complete'
    assert 'duration_ms' not in done
