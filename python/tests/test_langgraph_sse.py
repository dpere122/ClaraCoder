"""Tests for LangGraph SSE event mapping and log deduplication."""

from __future__ import annotations

import logging

import pytest
from langchain_core.messages import AIMessageChunk

from nemo_backend.langgraph_sse import GraphStreamState, sse_lines_for_graph_event


def _tool_end_event(*, name: str, run_id: str, output: str) -> dict[str, object]:
    return {
        'event': 'on_tool_end',
        'name': name,
        'run_id': run_id,
        'data': {'output': output},
    }


def test_duplicate_tool_end_is_logged_once(caplog: pytest.LogCaptureFixture) -> None:
    nemo = logging.getLogger('nemo')
    prev = nemo.propagate
    nemo.propagate = True
    try:
        caplog.set_level(logging.INFO, logger='nemo.tools.invoke')
        state = GraphStreamState()
        ev = _tool_end_event(
            name='route_code_review_specialist',
            run_id='run-123',
            output='Approved nested result\nSECOND LINE SHOULD NOT APPEAR IN TOOL LOG',
        )

        first = sse_lines_for_graph_event(
            ev,
            state,
            agent_role=None,
            status_label='Workspace',
            llm_event_prefix='nest',
            llm_log_context='test',
        )
        second = sse_lines_for_graph_event(
            ev,
            state,
            agent_role=None,
            status_label='Workspace',
            llm_event_prefix='nest',
            llm_log_context='test',
        )

        assert first
        assert second == []
        tool_logs = [record.message for record in caplog.records if 'LLM tool out' in record.message]
        assert len(tool_logs) == 1
        assert 'forwarded nested result omitted to reduce duplicate logs' in tool_logs[0]
        assert 'SECOND LINE SHOULD NOT APPEAR IN TOOL LOG' not in tool_logs[0]
    finally:
        nemo.propagate = prev


def test_tool_exec_chunk_event_is_forwarded() -> None:
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'tool_exec_chunk',
            'data': {
                'delta': 'test output line\n',
                'stream_tag': 'spec-code_review-tests',
                'label': 'Pytest',
            },
        },
        state,
        agent_role=None,
        status_label='Workspace',
        llm_event_prefix='nest',
        llm_log_context='test',
    )

    assert len(lines) == 1
    assert '"type": "tool_exec_chunk"' in lines[0]
    assert '"stream_tag": "spec-code_review-tests"' in lines[0]
    assert '"label": "Pytest"' in lines[0]


def test_outer_agent_brief_emits_status() -> None:
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'outer_agent_brief',
            'data': {
                'kind': 'plan_recorded',
                'summary': '1. First step\n2. Second step',
                'label': 'Planner checklist',
            },
        },
        state,
        agent_role=None,
        status_label='Workspace',
        llm_event_prefix='nest',
        llm_log_context='test',
    )
    assert len(lines) == 1
    assert '"type": "status"' in lines[0]
    assert '"label": "Planner checklist"' in lines[0]
    assert 'First step' in lines[0]
    assert '"stream_tag": "clara"' in lines[0]


def test_tool_exec_complete_event_is_forwarded() -> None:
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'tool_exec_complete',
            'data': {
                'stream_tag': 'spec-project_review-tests',
                'label': 'Workspace Pytest',
                'exit_code': 1,
            },
        },
        state,
        agent_role=None,
        status_label='Workspace',
        llm_event_prefix='nest',
        llm_log_context='test',
    )

    assert len(lines) == 1
    assert '"type": "tool_exec_complete"' in lines[0]
    assert '"stream_tag": "spec-project_review-tests"' in lines[0]
    assert '"exit_code": 1' in lines[0]


def test_chat_model_stream_tracks_partial_text_for_abort_fallback() -> None:
    state = GraphStreamState()

    first = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='Hello ')},
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    second = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='world')},
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )

    assert len(first) == 1
    assert len(second) == 1
    assert state.partial_stream_text == 'Hello world'
