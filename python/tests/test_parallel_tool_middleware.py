"""Tests for parallel tool-call middleware vs HITL (human-in-the-loop) review mode."""

from __future__ import annotations

import pytest

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.middleware.parallel_tool_middleware import _parallel_tool_calls_for_agent_request
from clara_coder_backend.session import state
@pytest.fixture
def hitl_session_id() -> str:
    sid = 'test-parallel-hitl-session'
    state.sessions.pop(sid, None)
    sess = state.get_session(sid)
    sess.worker_apply_mode = True
    sess.auto_apply_mode = False
    token = state.current_session_id.set(sid)
    yield sid
    state.current_session_id.reset(token)
    state.sessions.pop(sid, None)


def test_parallel_disabled_when_worker_apply_and_not_auto_apply(hitl_session_id: str) -> None:
    conn = RuntimeConnection(
        id='c1',
        name='c1',
        provider='openai',
        base_url='http://x',
        model='m',
        api_key='k',
        parallel_tool_calls=True,
    )
    prev = state.runtime_config.active_connection_id
    state.runtime_config.connections = [conn]
    state.runtime_config.active_connection_id = conn.id
    try:
        assert _parallel_tool_calls_for_agent_request() is False
    finally:
        state.runtime_config.active_connection_id = prev


def test_parallel_honored_when_auto_apply(hitl_session_id: str) -> None:
    state.get_session(hitl_session_id).auto_apply_mode = True
    conn = RuntimeConnection(
        id='c2',
        name='c2',
        provider='openai',
        base_url='http://x',
        model='m',
        api_key='k',
        parallel_tool_calls=True,
    )
    prev = state.runtime_config.active_connection_id
    state.runtime_config.connections = [conn]
    state.runtime_config.active_connection_id = conn.id
    try:
        assert _parallel_tool_calls_for_agent_request() is True
    finally:
        state.runtime_config.active_connection_id = prev


def test_parallel_respects_connection_when_no_hitl_pressure() -> None:
    sid = 'test-parallel-no-hitl'
    state.sessions.pop(sid, None)
    sess = state.get_session(sid)
    sess.worker_apply_mode = False
    sess.auto_apply_mode = False
    token = state.current_session_id.set(sid)
    conn = RuntimeConnection(
        id='c3',
        name='c3',
        provider='openai',
        base_url='http://x',
        model='m',
        api_key='k',
        parallel_tool_calls=True,
    )
    prev = state.runtime_config.active_connection_id
    state.runtime_config.connections = [conn]
    state.runtime_config.active_connection_id = conn.id
    try:
        assert _parallel_tool_calls_for_agent_request() is True
    finally:
        state.current_session_id.reset(token)
        state.runtime_config.active_connection_id = prev
        state.sessions.pop(sid, None)


def test_default_runtime_config_enables_parallel_tool_calls() -> None:
    cfg = state.build_default_runtime_config()
    assert cfg.connections
    assert all(conn.parallel_tool_calls for conn in cfg.connections)
