"""Tests for LangGraph SSE event mapping and log deduplication."""

from __future__ import annotations

import logging

from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk

from nemo_backend.domain import RuntimeConnection
from nemo_backend.langgraph_sse import GraphStreamState, sse_lines_for_graph_event


def _gemma_connection() -> RuntimeConnection:
    return RuntimeConnection(
        id='g',
        name='g',
        provider='llamacpp',
        base_url='http://127.0.0.1:8080/v1',
        model='google/gemma-4-12B-it',
        api_key='',
        reasoning_effort='',
        temperature=1.0,
        parallel_tool_calls=False,
        optimization_preset='gemma',
        max_output_tokens=0,
        plan_retry_attempts_count=2,
        thinking_mode='on',
    )


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
                'stream_tag': 'tool-pytest',
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
    assert '"stream_tag": "tool-pytest"' in lines[0]
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
    assert '"current_task"' in lines[0]
    assert 'First step' in lines[0]
    assert '"stream_tag": "clara"' in lines[0]
    assert '"id": "clara-current-task"' in lines[0]


def test_tool_exec_complete_event_is_forwarded() -> None:
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'tool_exec_complete',
            'data': {
                'stream_tag': 'tool-pytest',
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
    assert '"stream_tag": "tool-pytest"' in lines[0]
    assert '"exit_code": 1' in lines[0]


def test_tool_exec_complete_forwards_output_excerpt() -> None:
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'tool_exec_complete',
            'data': {
                'stream_tag': 'tool-pytest',
                'label': 'Workspace Pytest',
                'exit_code': 2,
                'output_excerpt': 'FAILED tests/test_x.py::test_a',
            },
        },
        state,
        agent_role=None,
        status_label='Workspace',
        llm_event_prefix='nest',
        llm_log_context='test',
    )

    assert len(lines) == 1
    assert '"output_excerpt": "FAILED tests/test_x.py::test_a"' in lines[0]


def test_chat_model_stream_discards_deferred_text_when_step_requests_tools() -> None:
    state = GraphStreamState()
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='Planning before tools. ')},
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    assert state.deferred_agent_text == 'Planning before tools. '
    end_lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_end',
            'data': {
                'output': AIMessage(
                    content='Planning before tools. ',
                    tool_calls=[{'name': 'read_file', 'args': {}, 'id': 'tc1', 'type': 'tool_call'}],
                ),
            },
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    assert not [ln for ln in end_lines if '"type": "chunk"' in ln and 'Planning' in ln]
    assert state.deferred_agent_text == ''


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

    assert len(first) == 0
    assert len(second) == 0
    assert state.deferred_agent_text == 'Hello world'
    end_lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_end',
            'data': {'output': AIMessage(content='Hello world')},
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    chunk_lines = [ln for ln in end_lines if '"type": "chunk"' in ln]
    assert len(chunk_lines) == 1
    assert 'Hello world' in chunk_lines[0]
    assert state.partial_stream_text == 'Hello world'


@patch('nemo_backend.langgraph_sse.get_active_connection')
def test_chat_model_stream_splits_gemma_channel_to_reasoning(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content="<|channel>thought\nI'm\nthinking<channel|>Hello!",
                ),
            },
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    assert len(lines) == 2
    assert '"delta": "Hello!"' in lines[0]
    assert '"stream_tag": "agent"' in lines[0]
    assert "I'm" in lines[1]
    assert '"stream_tag": "reasoning"' in lines[1]
    assert state.reasoning_emitted_this_step is True


def test_chat_model_stream_emits_reasoning_tag_for_reasoning_chunk() -> None:
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='Hi',
                    additional_kwargs={'reasoning_content': 'think'},
                ),
            },
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    assert len(lines) == 2
    assert '"delta": "Hi"' in lines[0]
    assert '"stream_tag": "agent"' in lines[0]
    assert '"delta": "think"' in lines[1]
    assert '"stream_tag": "reasoning"' in lines[1]
    assert state.reasoning_emitted_this_step is True


def test_chat_model_end_emits_reasoning_sidecar_when_not_streamed() -> None:
    state = GraphStreamState()
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_start',
            'data': {'input': []},
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    msg = AIMessage(
        content='Answer text.',
        additional_kwargs={'reasoning_content': 'Side reasoning only.'},
    )
    lines = sse_lines_for_graph_event(
        {'event': 'on_chat_model_end', 'data': {'output': msg}},
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    assert len(lines) == 2
    assert '"type": "chunk"' in lines[0]
    assert 'Side reasoning only' in lines[0]
    assert '"stream_tag": "reasoning"' in lines[0]
    assert '"type": "status"' in lines[1]


def test_chat_model_end_emits_token_usage_when_usage_metadata_present() -> None:
    state = GraphStreamState()
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_start',
            'data': {'input': []},
        },
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    msg = AIMessage(
        content='Ok.',
        usage_metadata={'input_tokens': 900, 'output_tokens': 12, 'total_tokens': 912},
    )
    lines = sse_lines_for_graph_event(
        {'event': 'on_chat_model_end', 'data': {'output': msg}},
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    usage_lines = [ln for ln in lines if '"type": "token_usage"' in ln]
    assert len(usage_lines) == 1
    assert '900' in usage_lines[0]
    assert '12' in usage_lines[0]


def test_hitl_sse_lines_diff_sentinel_only() -> None:
    from nemo_backend.agent_langgraph import _hitl_sse_lines
    from nemo_backend.domain import SessionState

    s = SessionState()
    payload = {'version': 1, 'rows': []}
    s.pending_diff_payload = payload
    lines = _hitl_sse_lines(s, ('diff',))
    assert len(lines) == 1
    assert 'diff' in lines[0]
    assert s.pending_diff_payload is None

    s1b = SessionState()
    embedded = {'version': 1, 'rows': [], 'relativePath': 'x.py'}
    lines_b = _hitl_sse_lines(s1b, ('diff', embedded))
    assert len(lines_b) == 1
    assert 'x.py' in lines_b[0]
    assert s1b.pending_diff_payload is None

    s2 = SessionState()
    assert _hitl_sse_lines(s2, ('diff',)) == []

    s3 = SessionState()
    s3.pending_diff_payload = {'version': 1, 'rows': []}
    assert _hitl_sse_lines(s3, ('unexpected',)) == []
    assert s3.pending_diff_payload is not None
