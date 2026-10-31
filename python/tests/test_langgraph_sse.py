"""Tests for LangGraph SSE event mapping and log deduplication."""

from __future__ import annotations

import json
import logging

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.lang_agent.langgraph_sse import GraphStreamState, sse_lines_for_graph_event


def _gemma_connection(*, thinking_mode: str = 'on') -> RuntimeConnection:
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
        thinking_mode=thinking_mode,
    )


def _tool_end_event(*, name: str, run_id: str, output: str) -> dict[str, object]:
    return {
        'event': 'on_tool_end',
        'name': name,
        'run_id': run_id,
        'data': {'output': output},
    }


def test_duplicate_tool_end_is_logged_once(caplog: pytest.LogCaptureFixture) -> None:
    nemo = logging.getLogger('clara')
    prev = nemo.propagate
    nemo.propagate = True
    try:
        caplog.set_level(logging.INFO, logger='clara.tools.invoke')
        state = GraphStreamState()
        ev = _tool_end_event(
            name='run_command',
            run_id='run-123',
            output='Command finished\nSECOND LINE IN OUTPUT',
        )

        caplog.clear()
        first = sse_lines_for_graph_event(
            ev,
            state,
            agent_role=None,
            status_label='Workspace',
            llm_event_prefix='nest',
            llm_log_context='test',
        )
        after_first = [record.message for record in caplog.records if 'LLM tool out' in record.message]
        second = sse_lines_for_graph_event(
            ev,
            state,
            agent_role=None,
            status_label='Workspace',
            llm_event_prefix='nest',
            llm_log_context='test',
        )
        after_second = [record.message for record in caplog.records if 'LLM tool out' in record.message]

        assert first
        assert second == []
        # Full-suite logging handlers can surface the same emission more than once;
        # assert the second tool_end adds no new log lines.
        assert after_first
        assert len(after_second) == len(after_first)
        assert 'Command finished' in after_first[0]
        assert 'SECOND LINE IN OUTPUT' in after_first[0]
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
    assert 'First step' in lines[0]
    assert 'Second step' in lines[0]
    assert '"stream_tag": "clara"' in lines[0]
    assert '"id": "outer-brief-' in lines[0]


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_outer_agent_brief_emits_status_for_gemma_preset(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'outer_agent_brief',
            'data': {
                'kind': 'plan_recorded',
                'summary': '1. First step',
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
    assert '"stream_tag": "clara"' in lines[0]
    assert 'First step' in lines[0]


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


def test_chat_model_stream_clears_primary_when_step_requests_tools() -> None:
    state = GraphStreamState()
    stream_lines = sse_lines_for_graph_event(
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
    assert len(stream_lines) == 1
    assert '"type": "chunk"' in stream_lines[0]
    assert 'Planning before tools. ' in stream_lines[0]
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
    assert any('"type": "clear_primary_stream"' in ln for ln in end_lines)
    assert state.deferred_agent_text == ''


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_gemma_preset_clears_primary_when_step_requests_tools(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
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
    assert any('"type": "clear_primary_stream"' in ln for ln in end_lines)
    assert state.deferred_agent_text == ''


def test_agent_nudge_event_promotes_primary_and_clears_final_text() -> None:
    state = GraphStreamState()
    state.last_final_text = 'Done staging.'
    state.deferred_agent_text = 'Done staging.'
    lines = sse_lines_for_graph_event(
        {'event': 'agent_nudge', 'data': {'reason': 'staging'}},
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    assert len(lines) == 1
    assert '"type": "promote_primary_to_nudge"' in lines[0]
    assert state.last_final_text == ''
    assert state.deferred_agent_text == ''


def test_chat_model_stream_emits_primary_live_and_skips_end_redump() -> None:
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
    assert 'Hello ' in first[0]
    assert len(second) == 1
    assert 'world' in second[0]
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
    assert chunk_lines == []
    assert state.partial_stream_text == 'Hello world'
    assert state.deferred_agent_text == ''


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
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
    # Primary and reasoning both stream live, in the order the model wrote them.
    assert len(lines) == 2
    assert "I'm" in lines[0]
    assert '"stream_tag": "reasoning"' in lines[0]
    assert 'Hello!' in lines[1]
    assert '"stream_tag": "agent"' in lines[1]
    assert state.deferred_agent_text == 'Hello!'
    assert state.reasoning_emitted_this_step is True


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_parses_thought_after_empty_channel_close(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='<|channel>thought\n<channel|>')},
        },
        state,
        **kwargs,
    )
    mid = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='still thinking about the file')},
        },
        state,
        **kwargs,
    )
    assert mid == []
    later = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='<channel|>Hello!')},
        },
        state,
        **kwargs,
    )
    assert any('still thinking about the file' in ln and '"stream_tag": "reasoning"' in ln for ln in later)
    assert any('Hello!' in ln and '"stream_tag": "agent"' in ln for ln in later)
    assert '<channel' not in ''.join(later)


def _sse_kwargs() -> dict[str, object]:
    return {
        'agent_role': None,
        'status_label': 'Agent',
        'llm_event_prefix': 'step',
        'llm_log_context': 'test',
        'stream_tag': 'agent',
    }


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_after_tool_maps_prompt_opened_thought(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    sse_lines_for_graph_event(
        _tool_end_event(name='read_workspace_file', run_id='r1', output='ok'),
        state,
        **_sse_kwargs(),
    )
    sse_lines_for_graph_event(
        {'event': 'on_chat_model_start', 'data': {'input': []}},
        state,
        **_sse_kwargs(),
    )
    first = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='Need the file ')},
        },
        state,
        **_sse_kwargs(),
    )
    assert len(first) == 1
    assert 'Need the file' in first[0]
    assert '"stream_tag": "reasoning"' in first[0]
    second = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='next.<channel|>Hello!')},
        },
        state,
        **_sse_kwargs(),
    )
    assert any('Hello!' in ln and '"stream_tag": "agent"' in ln for ln in second)
    assert any('next.' in ln and '"stream_tag": "reasoning"' in ln for ln in second)


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_nested_chat_model_start_after_tool_keeps_prompt_opened_thought(mock_conn: MagicMock) -> None:
    """Wrapper + ChatOpenAI both emit ``on_chat_model_start``; the second must not drop thought."""
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    sse_lines_for_graph_event(
        _tool_end_event(name='read_workspace_file', run_id='r-nested', output='ok'),
        state,
        **_sse_kwargs(),
    )
    first_start = sse_lines_for_graph_event(
        {'event': 'on_chat_model_start', 'data': {'input': []}},
        state,
        **_sse_kwargs(),
    )
    nested_start = sse_lines_for_graph_event(
        {'event': 'on_chat_model_start', 'data': {'input': []}},
        state,
        **_sse_kwargs(),
    )
    assert any('Thinking' in ln for ln in first_start)
    assert nested_start == []
    first = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='Need the file ')},
        },
        state,
        **_sse_kwargs(),
    )
    assert len(first) == 1
    assert 'Need the file' in first[0]
    assert '"stream_tag": "reasoning"' in first[0]


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_start_with_tool_message_opens_thought_without_tool_end_flag(
    mock_conn: MagicMock,
) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_start',
            'data': {
                'input': [
                    HumanMessage(content='Read the file'),
                    AIMessage(content='', tool_calls=[{'name': 'read_workspace_file', 'id': 'c1', 'args': {}}]),
                    ToolMessage(content='ok', tool_call_id='c1', name='read_workspace_file'),
                ],
            },
        },
        state,
        **_sse_kwargs(),
    )
    first = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='After the read ')},
        },
        state,
        **_sse_kwargs(),
    )
    assert len(first) == 1
    assert 'After the read' in first[0]
    assert '"stream_tag": "reasoning"' in first[0]


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_after_tool_uses_default_thinking_as_on(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection(thinking_mode='default')
    state = GraphStreamState()
    sse_lines_for_graph_event(
        _tool_end_event(name='read_workspace_file', run_id='r-default', output='ok'),
        state,
        **_sse_kwargs(),
    )
    sse_lines_for_graph_event(
        {'event': 'on_chat_model_start', 'data': {'input': []}},
        state,
        **_sse_kwargs(),
    )
    first = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='Need the file ')},
        },
        state,
        **_sse_kwargs(),
    )
    assert '"stream_tag": "reasoning"' in first[0]


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_after_tool_stays_visible_when_thinking_off(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection(thinking_mode='off')
    state = GraphStreamState()
    sse_lines_for_graph_event(
        _tool_end_event(name='read_workspace_file', run_id='r-off', output='ok'),
        state,
        **_sse_kwargs(),
    )
    sse_lines_for_graph_event(
        {'event': 'on_chat_model_start', 'data': {'input': []}},
        state,
        **_sse_kwargs(),
    )
    first = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='Need the file ')},
        },
        state,
        **_sse_kwargs(),
    )
    assert len(first) == 1
    assert 'Need the file' in first[0]
    assert '"stream_tag": "agent"' in first[0]


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_after_tool_still_honors_explicit_channel(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    sse_lines_for_graph_event(
        _tool_end_event(name='read_workspace_file', run_id='r2', output='ok'),
        state,
        **_sse_kwargs(),
    )
    sse_lines_for_graph_event(
        {'event': 'on_chat_model_start', 'data': {'input': []}},
        state,
        **_sse_kwargs(),
    )
    lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content="<|channel>thought\nplan<channel|>Hello!",
                ),
            },
        },
        state,
        **_sse_kwargs(),
    )
    assert any('Hello!' in ln and '"stream_tag": "agent"' in ln for ln in lines)
    assert any('plan' in ln and '"stream_tag": "reasoning"' in ln for ln in lines)


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_empty_channel_then_thought_before_tool_call(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='<|channel>thought\n<channel|>')},
        },
        state,
        **kwargs,
    )
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='I should list files next')},
        },
        state,
        **kwargs,
    )
    later = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='<|tool_call>call:list_workspace_directory{relative_path:<|"|>.<|"|>}<tool_call|>',
                ),
            },
        },
        state,
        **kwargs,
    )
    assert any('I should list files next' in ln and '"stream_tag": "reasoning"' in ln for ln in later)
    assert not any('I should list files next' in ln and '"stream_tag": "agent"' in ln for ln in later)
    assert not any('<|tool_call>' in ln for ln in later)


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_strips_nested_channel_tags_from_reasoning(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content=(
                        "<|channel>thought\nouter\n"
                        "<|channel>thought\ninner<channel|>Hello!"
                    ),
                ),
            },
        },
        state,
        **_sse_kwargs(),
    )
    reason_lines = [ln for ln in lines if '"stream_tag": "reasoning"' in ln]
    assert reason_lines
    assert '<|channel>' not in reason_lines[0]
    assert '<channel' not in reason_lines[0]
    assert 'outer' in reason_lines[0]
    assert 'inner' in reason_lines[0]


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_strips_tags_from_reasoning_sidecar(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='Hello!',
                    additional_kwargs={'reasoning_content': '<channel thought>plan it'},
                ),
            },
        },
        state,
        **_sse_kwargs(),
    )
    reason_lines = [ln for ln in lines if '"stream_tag": "reasoning"' in ln]
    assert reason_lines
    assert '<channel' not in reason_lines[0]
    assert 'plan it' in reason_lines[0]


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
    # A chunk that ends the thought and starts the answer: reasoning first.
    assert len(lines) == 2
    assert '"delta": "think"' in lines[0]
    assert '"stream_tag": "reasoning"' in lines[0]
    assert '"delta": "Hi"' in lines[1]
    assert '"stream_tag": "agent"' in lines[1]
    assert state.deferred_agent_text == 'Hi'
    assert state.stream_chunks == 1
    assert state.stream_chars == len('Hi') + len('think')
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
    # No token was streamed, so there is no decode window to report.
    assert 'generation_ms' not in usage_lines[0]


def test_chat_model_end_reports_generation_ms_from_first_streamed_token(monkeypatch) -> None:
    import clara_coder_backend.lang_agent.langgraph_sse as sse_mod

    clock = iter([10.0, 12.5])
    monkeypatch.setattr(sse_mod.time, 'monotonic', lambda: next(clock))
    state = GraphStreamState()
    common = dict(
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
        stream_tag='agent',
    )
    sse_lines_for_graph_event({'event': 'on_chat_model_start', 'data': {'input': []}}, state, **common)
    for text in ('Hel', 'lo'):
        sse_lines_for_graph_event(
            {'event': 'on_chat_model_stream', 'data': {'chunk': AIMessageChunk(content=text)}},
            state,
            **common,
        )
    msg = AIMessage(
        content='Hello',
        usage_metadata={'input_tokens': 50, 'output_tokens': 40, 'total_tokens': 90},
    )
    lines = sse_lines_for_graph_event({'event': 'on_chat_model_end', 'data': {'output': msg}}, state, **common)
    usage = json.loads(next(ln for ln in lines if '"type": "token_usage"' in ln).removeprefix('data: '))
    assert usage['output_tokens'] == 40
    assert usage['generation_ms'] == 2500


@pytest.mark.asyncio(loop_scope='function')
async def test_hitl_sse_lines_no_longer_emit_edit_cards() -> None:
    from clara_coder_backend.lang_agent.graph import _hitl_sse_lines
    from clara_coder_backend.domain import SessionState

    s = SessionState()
    assert await _hitl_sse_lines(s, ('diff', {'version': 1, 'rows': []})) == []
    assert await _hitl_sse_lines(s, ('copy',)) == []



@pytest.mark.asyncio(loop_scope='function')
async def test_hitl_sse_lines_agent_nudge() -> None:
    from clara_coder_backend.lang_agent.graph import _hitl_sse_lines
    from clara_coder_backend.domain import SessionState

    s = SessionState()
    lines = await _hitl_sse_lines(s, ('agent_nudge', {'reason': 'empty'}))
    assert len(lines) == 1
    assert '"type": "promote_primary_to_nudge"' in lines[0]


@pytest.mark.asyncio(loop_scope='function')
async def test_hitl_sse_lines_accept_command_skips_risk_enrichment_when_setting_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL
    from clara_coder_backend.lang_agent.graph import _hitl_sse_lines
    from clara_coder_backend.domain import SessionState
    from clara_coder_backend.session.state import runtime_config

    monkeypatch.setattr(runtime_config.tools, 'command_line_explain_step', False, raising=False)

    s = SessionState()
    s.pending_accept_command_request = {
        'request_id': 'req-1',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run terminal command',
        'message': 'Run a shell command in the workspace.',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': 'ls -la',
        'details': [],
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'ls -la', 'cwd': ''},
        },
    }

    with patch('clara_coder_backend.lang_agent.graph.maybe_enrich_pending_command_risk') as mock_enrich:
        lines = await _hitl_sse_lines(s, ('accept_command',))

    assert len(lines) == 1
    assert mock_enrich.await_count == 1
    assert '"riskAssessmentStatus"' not in lines[0]
    assert '"riskLevel"' not in lines[0]
    assert '"riskDescription"' not in lines[0]


@pytest.mark.asyncio(loop_scope='function')
async def test_hitl_sse_lines_accept_command_includes_risk_fields_when_enriched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from clara_coder_backend.hitl.accept_command import ACCEPT_COMMAND_KIND_DEFERRED_TOOL
    from clara_coder_backend.lang_agent.graph import _hitl_sse_lines
    from clara_coder_backend.domain import SessionState
    from clara_coder_backend.session.state import runtime_config

    monkeypatch.setattr(runtime_config.tools, 'command_line_explain_step', True, raising=False)

    s = SessionState()
    s.pending_accept_command_request = {
        'request_id': 'req-2',
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': 'Run terminal command',
        'message': 'Run a shell command in the workspace.',
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': 'rm -rf build',
        'details': [],
        'action': {
            'tool_name': 'run_command',
            'tool_input': {'command': 'rm -rf build', 'cwd': ''},
        },
    }

    async def _fake_enrich(pending: dict) -> None:
        pending['risk_assessment_status'] = 'ok'
        pending['risk_level'] = 'medium'
        pending['risk_description'] = 'Deletes the build directory.'

    with patch(
        'clara_coder_backend.lang_agent.graph.maybe_enrich_pending_command_risk',
        new=AsyncMock(side_effect=_fake_enrich),
    ) as mock_enrich:
        lines = await _hitl_sse_lines(s, ('accept_command',))

    assert len(lines) == 1
    assert mock_enrich.await_count == 1
    assert '"riskAssessmentStatus": "ok"' in lines[0]
    assert '"riskLevel": "medium"' in lines[0]
    assert 'Deletes the build directory.' in lines[0]


def _sse_json(line: str) -> dict:
    return json.loads(line.removeprefix('data: ').strip())


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_previews_write_tool_before_native_block_closes(
    mock_conn: MagicMock,
) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    named = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='<|tool_call>call:stage_workspace_file_overwrite{',
                ),
            },
        },
        state,
        **kwargs,
    )
    named_status = [_sse_json(ln)['status'] for ln in named if '"type": "status"' in ln]
    assert named_status
    assert named_status[0]['label'] == 'stage_workspace_file_overwrite'
    assert named_status[0]['state'] == 'running'
    assert named_status[0]['source'] == 'tool'
    preview_id = named_status[0]['id']
    assert preview_id.startswith('gemma-tool-preview-')

    pathed = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='relative_path:<|"|>src/app.ts<|"|>,new_content:<|"|>const x = 1',
                ),
            },
        },
        state,
        **kwargs,
    )
    pathed_status = [_sse_json(ln)['status'] for ln in pathed if '"type": "status"' in ln]
    assert pathed_status
    assert pathed_status[0]['id'] == preview_id
    assert pathed_status[0]['detail'] == 'src/app.ts'

    quiet = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content=';\nconst y = 2')},
        },
        state,
        **kwargs,
    )
    assert not any('"type": "status"' in ln for ln in quiet)

    start = sse_lines_for_graph_event(
        {
            'event': 'on_tool_start',
            'name': 'stage_workspace_file_overwrite',
            'run_id': 'lg-run-1',
            'data': {'input': {'relative_path': 'src/app.ts', 'new_content': 'const x = 1;\nconst y = 2'}},
        },
        state,
        **kwargs,
    )
    start_status = [_sse_json(ln)['status'] for ln in start if '"type": "status"' in ln]
    assert start_status[0]['id'] == preview_id

    end = sse_lines_for_graph_event(
        {
            'event': 'on_tool_end',
            'name': 'stage_workspace_file_overwrite',
            'run_id': 'lg-run-1',
            'data': {'output': 'Staged src/app.ts'},
        },
        state,
        **kwargs,
    )
    end_status = [_sse_json(ln)['status'] for ln in end if '"type": "status"' in ln]
    assert end_status[0]['id'] == preview_id
    assert end_status[0]['state'] == 'complete'


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_end_completes_unclosed_write_preview(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    named = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='<|tool_call>call:stage_workspace_file_overwrite{relative_path:<|"|>a.ts<|"|>,new_content:<|"|>x',
                ),
            },
        },
        state,
        **kwargs,
    )
    preview_id = [_sse_json(ln)['status']['id'] for ln in named if '"type": "status"' in ln][0]
    assert preview_id in state.pending_tool_runs
    end_lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_end',
            'data': {'output': AIMessage(content='truncated')},
        },
        state,
        **kwargs,
    )
    done = [
        _sse_json(ln)['status']
        for ln in end_lines
        if '"type": "status"' in ln and _sse_json(ln)['status']['id'] == preview_id
    ]
    assert done
    assert done[0]['state'] == 'complete'
    assert preview_id not in state.pending_tool_runs


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_end_completes_closed_unparseable_write_preview(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    named = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='<|tool_call>call:stage_create_file{relative_path:<|"|>a.py<|"|>!!!}<tool_call|>',
                ),
            },
        },
        state,
        **kwargs,
    )
    preview_id = [_sse_json(ln)['status']['id'] for ln in named if '"type": "status"' in ln][0]
    end_lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_end',
            'data': {
                'output': AIMessage(
                    content='<|tool_call>call:stage_create_file{relative_path:<|"|>a.py<|"|>!!!}<tool_call|>',
                ),
            },
        },
        state,
        **kwargs,
    )
    done = [
        _sse_json(ln)['status']
        for ln in end_lines
        if '"type": "status"' in ln and _sse_json(ln)['status']['id'] == preview_id
    ]
    assert done
    assert done[0]['state'] == 'complete'
    assert preview_id not in state.pending_tool_runs


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_stream_previews_two_native_tool_calls_share_ids(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    streamed = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content=(
                        '<|tool_call>call:list_workspace_directory{relative_path:<|"|>src<|"|>}<tool_call|>'
                        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
                    ),
                ),
            },
        },
        state,
        **kwargs,
    )
    previews = [_sse_json(ln)['status'] for ln in streamed if '"type": "status"' in ln]
    assert [row['label'] for row in previews] == [
        'list_workspace_directory',
        'read_workspace_file',
    ]
    assert all(row['state'] == 'running' and row['source'] == 'tool' for row in previews)
    ids = [row['id'] for row in previews]
    assert ids[0] != ids[1]
    assert all(item.startswith('gemma-tool-preview-') for item in ids)

    first_start = sse_lines_for_graph_event(
        {
            'event': 'on_tool_start',
            'name': 'list_workspace_directory',
            'run_id': 'lg-run-a',
            'data': {'input': {'relative_path': 'src'}},
        },
        state,
        **kwargs,
    )
    first_status = [_sse_json(ln)['status'] for ln in first_start if '"type": "status"' in ln]
    assert first_status[0]['id'] == ids[0]
    assert first_status[0]['label'] == 'list_workspace_directory'

    second_start = sse_lines_for_graph_event(
        {
            'event': 'on_tool_start',
            'name': 'read_workspace_file',
            'run_id': 'lg-run-b',
            'data': {'input': {'path': 'a.py'}},
        },
        state,
        **kwargs,
    )
    second_status = [_sse_json(ln)['status'] for ln in second_start if '"type": "status"' in ln]
    assert second_status[0]['id'] == ids[1]
    assert second_status[0]['label'] == 'read_workspace_file'
    assert set(state.gemma_run_id_alias.values()) == set(ids)


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_chat_model_start_after_injected_human_does_not_inherit_thought(
    mock_conn: MagicMock,
) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    sse_lines_for_graph_event(
        _tool_end_event(name='read_workspace_file', run_id='r-nudge', output='ok'),
        state,
        **_sse_kwargs(),
    )
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_start',
            'data': {'input': [HumanMessage(content='You ended with leftover drafts.')]},
        },
        state,
        **_sse_kwargs(),
    )
    first = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': AIMessageChunk(content='I will transfer now.')},
        },
        state,
        **_sse_kwargs(),
    )
    assert len(first) == 1
    assert 'I will transfer now.' in first[0]
    assert '"stream_tag": "agent"' in first[0]
    assert '"stream_tag": "reasoning"' not in first[0]


@patch('clara_coder_backend.lang_agent.langgraph_sse.get_active_connection')
def test_parallel_same_name_previews_bind_by_path(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _gemma_connection()
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    streamed = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content=(
                        '<|tool_call>call:read_workspace_file{path:<|"|>a.py<|"|>}<tool_call|>'
                        '<|tool_call>call:read_workspace_file{path:<|"|>b.py<|"|>}<tool_call|>'
                    ),
                ),
            },
        },
        state,
        **kwargs,
    )
    previews = [_sse_json(ln)['status'] for ln in streamed if '"type": "status"' in ln]
    assert [row['label'] for row in previews] == ['read_workspace_file', 'read_workspace_file']
    ids = [row['id'] for row in previews]
    assert ids[0] != ids[1]

    second_first = sse_lines_for_graph_event(
        {
            'event': 'on_tool_start',
            'name': 'read_workspace_file',
            'run_id': 'lg-b',
            'data': {'input': {'path': 'b.py'}},
        },
        state,
        **kwargs,
    )
    first_second = sse_lines_for_graph_event(
        {
            'event': 'on_tool_start',
            'name': 'read_workspace_file',
            'run_id': 'lg-a',
            'data': {'input': {'path': 'a.py'}},
        },
        state,
        **kwargs,
    )
    assert [_sse_json(ln)['status']['id'] for ln in second_first if '"type": "status"' in ln] == [ids[1]]
    assert [_sse_json(ln)['status']['id'] for ln in first_second if '"type": "status"' in ln] == [ids[0]]
    assert state.gemma_run_id_alias['lg-b'] == ids[1]
    assert state.gemma_run_id_alias['lg-a'] == ids[0]


def _native_tool_chunk(*, index: int, name: str | None = None, args: str = '', call_id: str | None = None) -> AIMessageChunk:
    return AIMessageChunk(
        content='',
        tool_call_chunks=[{'name': name, 'args': args, 'id': call_id, 'index': index}],
    )


def test_native_tool_call_chunks_preview_write_tool_while_args_stream() -> None:
    state = GraphStreamState()
    kwargs = _sse_kwargs()

    named = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': _native_tool_chunk(index=0, name='stage_create_file', args='', call_id='call_1')},
        },
        state,
        **kwargs,
    )
    named_status = [_sse_json(ln)['status'] for ln in named if '"type": "status"' in ln]
    assert named_status
    assert named_status[0]['label'] == 'stage_create_file'
    assert named_status[0]['state'] == 'running'
    assert named_status[0]['source'] == 'tool'
    preview_id = named_status[0]['id']
    assert preview_id.startswith('native-tool-preview-')
    assert preview_id in state.pending_tool_runs

    pathed = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': _native_tool_chunk(index=0, args='{"relative_path": "src/app.ts", "new_content": "')},
        },
        state,
        **kwargs,
    )
    pathed_status = [_sse_json(ln)['status'] for ln in pathed if '"type": "status"' in ln]
    assert pathed_status
    assert pathed_status[0]['id'] == preview_id
    assert pathed_status[0]['detail'] == 'src/app.ts'

    # Small deltas do not re-announce until the buffer grows by a step.
    quiet = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': _native_tool_chunk(index=0, args='const x = 1;\\n')},
        },
        state,
        **kwargs,
    )
    assert not any('"type": "status"' in ln for ln in quiet)

    big = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': _native_tool_chunk(index=0, args='x' * 1200)},
        },
        state,
        **kwargs,
    )
    big_status = [_sse_json(ln)['status'] for ln in big if '"type": "status"' in ln]
    assert big_status
    assert big_status[0]['id'] == preview_id
    assert big_status[0]['detail'].startswith('src/app.ts · drafting ')
    assert 'KB' in big_status[0]['detail']

    start = sse_lines_for_graph_event(
        {
            'event': 'on_tool_start',
            'name': 'stage_create_file',
            'run_id': 'lg-run-native',
            'data': {'input': {'relative_path': 'src/app.ts', 'new_content': 'const x = 1;'}},
        },
        state,
        **kwargs,
    )
    start_status = [_sse_json(ln)['status'] for ln in start if '"type": "status"' in ln]
    assert start_status[0]['id'] == preview_id
    assert start_status[0]['detail'] == 'src/app.ts'
    assert preview_id not in state.pending_tool_runs
    assert 'lg-run-native' in state.pending_tool_runs

    end = sse_lines_for_graph_event(
        {
            'event': 'on_tool_end',
            'name': 'stage_create_file',
            'run_id': 'lg-run-native',
            'data': {'output': 'Staged src/app.ts'},
        },
        state,
        **kwargs,
    )
    end_status = [_sse_json(ln)['status'] for ln in end if '"type": "status"' in ln]
    assert end_status[0]['id'] == preview_id
    assert end_status[0]['state'] == 'complete'


def test_native_tool_call_chunks_parallel_calls_get_distinct_previews() -> None:
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    first = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='',
                    tool_call_chunks=[
                        {'name': 'read_workspace_file', 'args': '{"path": "a.py"}', 'id': 'c1', 'index': 0},
                        {'name': 'read_workspace_file', 'args': '{"path": "b.py"}', 'id': 'c2', 'index': 1},
                    ],
                ),
            },
        },
        state,
        **kwargs,
    )
    rows = [_sse_json(ln)['status'] for ln in first if '"type": "status"' in ln]
    assert [row['detail'] for row in rows] == ['a.py', 'b.py']
    assert rows[0]['id'] != rows[1]['id']

    bound_b = sse_lines_for_graph_event(
        {
            'event': 'on_tool_start',
            'name': 'read_workspace_file',
            'run_id': 'lg-b',
            'data': {'input': {'path': 'b.py'}},
        },
        state,
        **kwargs,
    )
    assert [_sse_json(ln)['status']['id'] for ln in bound_b if '"type": "status"' in ln] == [rows[1]['id']]


def test_native_tool_previews_stay_distinct_across_streams_of_one_turn() -> None:
    """Plan discovery then execution each stream with a fresh state; the renderer keys rows by id."""
    kwargs = _sse_kwargs()
    event = {
        'event': 'on_chat_model_stream',
        'data': {'chunk': _native_tool_chunk(index=0, name='read_workspace_file', args='', call_id='c1')},
    }
    ids = []
    for state in (GraphStreamState(), GraphStreamState()):
        lines = sse_lines_for_graph_event(event, state, **kwargs)
        ids += [_sse_json(ln)['status']['id'] for ln in lines if '"type": "status"' in ln]
    assert len(ids) == 2
    assert all(i.startswith('native-tool-preview-') for i in ids)
    assert ids[0] != ids[1]


def _stream_line_kinds(lines: list[str]) -> list[tuple[str, str]]:
    kinds: list[tuple[str, str]] = []
    for ln in lines:
        row = _sse_json(ln)
        if row['type'] == 'chunk':
            kinds.append(('chunk', row['delta']))
        elif row['type'] == 'status':
            kinds.append(('status', row['status']['label']))
    return kinds


def test_native_tool_preview_follows_reasoning_tail_in_the_same_chunk() -> None:
    """A thought's last words and the first tool call delta can share one provider chunk."""
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content='',
                    additional_kwargs={'reasoning': ' inspect.'},
                    tool_call_chunks=[{'name': 'read_workspace_file', 'args': '', 'id': 'c1', 'index': 0}],
                ),
            },
        },
        state,
        **_sse_kwargs(),
    )
    assert _stream_line_kinds(lines) == [('chunk', ' inspect.'), ('status', 'read_workspace_file')]


def test_native_tool_preview_follows_prose_tail_in_the_same_chunk() -> None:
    state = GraphStreamState()
    lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {
                'chunk': AIMessageChunk(
                    content=' spawn code.',
                    tool_call_chunks=[{'name': 'search_workspace', 'args': '', 'id': 'c1', 'index': 0}],
                ),
            },
        },
        state,
        **_sse_kwargs(),
    )
    assert _stream_line_kinds(lines) == [('chunk', ' spawn code.'), ('status', 'search_workspace')]


def test_native_preview_reset_per_llm_step_and_completed_when_no_tool_calls() -> None:
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_stream',
            'data': {'chunk': _native_tool_chunk(index=0, name='stage_create_file', args='{"relative_path": "a.py"')},
        },
        state,
        **kwargs,
    )
    preview_id = next(iter(state.native_tool_drafts.values())).preview_id
    end_lines = sse_lines_for_graph_event(
        {
            'event': 'on_chat_model_end',
            'data': {'output': AIMessage(content='I changed my mind.')},
        },
        state,
        **kwargs,
    )
    done = [
        _sse_json(ln)['status']
        for ln in end_lines
        if '"type": "status"' in ln and _sse_json(ln)['status']['id'] == preview_id
    ]
    assert done and done[0]['state'] == 'complete'
    assert preview_id not in state.pending_tool_runs

    sse_lines_for_graph_event(
        {'event': 'on_chat_model_start', 'data': {'input': {'messages': [HumanMessage(content='hi')]}}},
        state,
        **kwargs,
    )
    assert state.native_tool_drafts == {}


def test_tool_progress_folds_into_running_tool_pill() -> None:
    from clara_coder_backend.lang_agent.langgraph_sse import tool_progress_sse_lines

    state = GraphStreamState()
    kwargs = _sse_kwargs()
    start = sse_lines_for_graph_event(
        {
            'event': 'on_tool_start',
            'name': 'stage_snippet_edit',
            'run_id': 'lg-run-2',
            'data': {'input': {'relative_path': 'src/a.ts', 'old_snippet': 'x', 'new_snippet': 'y'}},
        },
        state,
        **kwargs,
    )
    status_id = [_sse_json(ln)['status']['id'] for ln in start if '"type": "status"' in ln][0]

    lines = tool_progress_sse_lines(
        {'tool_name': 'stage_snippet_edit', 'relative_path': 'src/a.ts', 'detail': 'src/a.ts · formatting'},
        states=[state],
        agent_role=None,
        stream_tag='agent',
    )
    rows = [_sse_json(ln)['status'] for ln in lines]
    assert rows == [
        {
            'id': status_id,
            'label': 'stage_snippet_edit',
            'detail': 'src/a.ts · formatting',
            'state': 'running',
            'source': 'tool',
            'stream_tag': 'agent',
        }
    ]

    # Unknown tool → nothing (no orphan pill).
    assert tool_progress_sse_lines(
        {'tool_name': 'stage_create_file', 'relative_path': 'other.ts', 'detail': 'other.ts · writing to disk'},
        states=[state],
        agent_role=None,
        stream_tag='agent',
    ) == []


def test_tool_rows_carry_llm_step_batch_so_ui_splits_sequential_steps() -> None:
    """Models that stream no reasoning between steps (encrypted Gemini reasoning) still get one pill per step."""
    state = GraphStreamState()
    kwargs = _sse_kwargs()
    batches: list[str] = []
    for step, path in ((1, 'a.py'), (2, 'b.py')):
        sse_lines_for_graph_event(
            {'event': 'on_chat_model_start', 'data': {'input': {'messages': [HumanMessage(content='hi')]}}},
            state,
            **kwargs,
        )
        preview = sse_lines_for_graph_event(
            {
                'event': 'on_chat_model_stream',
                'data': {'chunk': _native_tool_chunk(index=0, name='read_workspace_file', args=f'{{"path": "{path}"}}', call_id=f'c{step}')},
            },
            state,
            **kwargs,
        )
        sse_lines_for_graph_event(
            {
                'event': 'on_chat_model_end',
                'data': {'output': AIMessage(content='', tool_calls=[{'name': 'read_workspace_file', 'args': {'path': path}, 'id': f'c{step}'}])},
            },
            state,
            **kwargs,
        )
        start = sse_lines_for_graph_event(
            {'event': 'on_tool_start', 'name': 'read_workspace_file', 'run_id': f'lg-{step}', 'data': {'input': {'path': path}}},
            state,
            **kwargs,
        )
        rows = [_sse_json(ln)['status'] for ln in preview + start if '"type": "status"' in ln]
        assert len({row['id'] for row in rows}) == 1
        assert len({row['tool_batch'] for row in rows}) == 1
        batches.append(rows[0]['tool_batch'])
    assert batches[0] != batches[1]


def _sse_payloads(lines: list[str]) -> list[dict[str, object]]:
    return [json.loads(line.removeprefix('data: ').strip()) for line in lines]


def test_subagent_started_custom_event_targets_the_aliased_spawn_pill() -> None:
    """The spawn call's start event goes on the sub-agent bus with the pill id; the parent stream only
    gets the pill's running update (linked to the child)."""
    from clara_coder_backend.domain import SessionState
    from clara_coder_backend.lang_agent import subagents
    from clara_coder_backend.lang_agent.subagent_bus import SUBAGENT_BUS

    state = GraphStreamState()
    # The pill was opened by a streaming preview; the tool run is an alias of it.
    state.gemma_run_id_alias['tool-run-1'] = 'native-tool-preview-3'
    state.pending_tool_runs['tool-run-1'] = ('spawn_subagent', {'task': 'look', 'name': 'scout'})
    parent, child = SessionState(), SessionState()
    run = subagents.SubagentRun(
        parent_session_id='parent-1',
        parent=parent,
        child_id='child-abc123',
        child=child,
        name='scout-2',
        task_text='look',
        background=True,
        parent_turn_id='turn-5',
    )
    subagents.register_subagent_run(run)
    event = {
        'event': 'on_custom_event',
        'name': subagents.SUBAGENT_STARTED_EVENT,
        'run_id': 'tool-run-1',
        'data': {
            'conversation_id': 'child-abc123',
            'parent_conversation_id': 'parent-1',
            'parent_turn_id': 'turn-5',
            'name': 'scout-2',
            'task': 'look',
            'background': True,
        },
    }
    kwargs = dict(agent_role=None, status_label='Agent', llm_event_prefix='step', llm_log_context='test', stream_tag='agent')
    lines = sse_lines_for_graph_event(event, state, **kwargs)
    # A second sighting (or the child's own fallback) never announces twice.
    again = sse_lines_for_graph_event(event, state, **kwargs)

    [running] = _sse_payloads(lines)
    status = running['status']
    assert status['id'] == 'native-tool-preview-3' and status['state'] == 'running'
    assert status['subagent'] == {'conversation_id': 'child-abc123', 'name': 'scout-2'}
    assert status['detail'] == 'scout-2'
    assert not any(p.get('type', '').startswith('subagent_') for p in _sse_payloads(lines + again))
    assert run.announced.is_set()
    assert SUBAGENT_BUS.buffered() == [
        {
            'type': 'subagent_started',
            'conversation_id': 'child-abc123',
            'parent_conversation_id': 'parent-1',
            'parent_turn_id': 'turn-5',
            'name': 'scout-2',
            'task': 'look',
            'status_id': 'native-tool-preview-3',
            'background': True,
        }
    ]


def test_spawn_result_artifact_links_the_finished_pill() -> None:
    state = GraphStreamState()
    state.pending_tool_runs['run-9'] = ('spawn_subagent', {})
    out = ToolMessage(
        content='Sub-agent `scout` finished. Its report:\n\nok',
        tool_call_id='call-9',
        name='spawn_subagent',
        artifact={'subagent': {'conversation_id': 'child-abc123', 'name': 'scout'}},
    )
    lines = sse_lines_for_graph_event(
        {'event': 'on_tool_end', 'name': 'spawn_subagent', 'run_id': 'run-9', 'data': {'output': out}},
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
    )
    [finished] = [p for p in _sse_payloads(lines) if p['type'] == 'status']
    assert finished['status']['state'] == 'complete'
    assert finished['status']['subagent'] == {'conversation_id': 'child-abc123', 'name': 'scout'}

    plain = ToolMessage(content='read ok', tool_call_id='call-10', name='read_workspace_file')
    other = sse_lines_for_graph_event(
        {'event': 'on_tool_end', 'name': 'read_workspace_file', 'run_id': 'run-10', 'data': {'output': plain}},
        state,
        agent_role=None,
        status_label='Agent',
        llm_event_prefix='step',
        llm_log_context='test',
    )
    assert all('subagent' not in p.get('status', {}) for p in _sse_payloads(other))
