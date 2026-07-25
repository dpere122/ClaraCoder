"""Workspace system prompt injection into build_system_prompt."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from starlette.testclient import TestClient

from nemo_backend.domain import RuntimeConnection, SessionState
from nemo_backend.messages import build_system_prompt


def _conn() -> RuntimeConnection:
    return RuntimeConnection(
        id='c',
        name='test',
        provider='openai',
        base_url='http://127.0.0.1:1234/v1',
        model='test-model',
        api_key='',
        reasoning_effort='',
        temperature=1.0,
        parallel_tool_calls=False,
        optimization_preset='generic',
        max_output_tokens=0,
        plan_retry_attempts_count=2,
    )


@patch('nemo_backend.messages.get_active_connection')
def test_build_system_prompt_includes_workspace_system_prompt(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn()
    session = SessionState(
        workspace_path='/tmp/project',
        workspace_context='.\n  src/',
        workspace_system_prompt='Always run pytest before claiming done.',
    )
    prompt = build_system_prompt(session, apply_mode=False)
    assert 'Workspace system prompt:' in prompt
    assert 'Always run pytest before claiming done.' in prompt


@patch('nemo_backend.messages.get_active_connection')
def test_build_system_prompt_omits_empty_workspace_system_prompt(mock_conn: MagicMock) -> None:
    mock_conn.return_value = _conn()
    session = SessionState(
        workspace_path='/tmp/project',
        workspace_context='.\n  src/',
        workspace_system_prompt='',
    )
    prompt = build_system_prompt(session, apply_mode=False)
    assert 'Workspace system prompt:' not in prompt


def test_workspace_system_prompt_route_updates_session_without_tree() -> None:
    from nemo_backend import state
    from nemo_backend.main import app

    sid = 'sys-prompt-route-test'
    sess = state.get_session(sid)
    sess.workspace_path = '/tmp/project'
    sess.workspace_context = 'tree stays'
    sess.workspace_system_prompt = ''

    client = TestClient(app)
    res = client.post(
        '/workspace-system-prompt',
        json={'session_id': sid, 'workspace_system_prompt': 'Live inject now.'},
    )
    assert res.status_code == 200
    assert res.json() == {'ok': True}
    assert state.get_session(sid).workspace_system_prompt == 'Live inject now.'
    assert state.get_session(sid).workspace_context == 'tree stays'
