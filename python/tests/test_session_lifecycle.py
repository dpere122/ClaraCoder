"""Session teardown, dispose, idle eviction, and /load normalization."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from starlette.testclient import TestClient


def test_load_normalizes_message_and_structured_content(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'life-load.sqlite'))
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    with patch('clara_coder_backend.routes.session.delete_outer_threads_for_session', new_callable=AsyncMock):
        with TestClient(app) as client:
            r = client.post(
                '/load',
                json={
                    'session_id': 'norm',
                    'messages': [
                        {
                            'role': 'user',
                            'message': 'hello',
                            'structuredContent': [{'type': 'image_url', 'image_url': {'url': 'data:x'}}],
                        },
                        {'role': 'assistant', 'content': 'hi'},
                    ],
                },
            )
            assert r.status_code == 200
    hist = state.sessions['norm'].history
    assert hist[0]['role'] == 'user'
    assert isinstance(hist[0]['content'], list)
    assert hist[0]['content'][0] == {'type': 'text', 'text': 'hello'}
    assert hist[1] == {'role': 'assistant', 'content': 'hi'}


@patch('clara_coder_backend.session.lifecycle.delete_outer_threads_for_session', new_callable=AsyncMock)
def test_prune_idle_sessions_evicts_untouched(
    mock_delete: AsyncMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    from clara_coder_backend.domain import SessionState
    from clara_coder_backend.session import state

    state.sessions.clear()
    state.current_session_id.set('keep')
    keep = SessionState()
    keep.last_touched = 1e12
    idle = SessionState()
    idle.last_touched = 1.0
    state.sessions['keep'] = keep
    state.sessions['idle'] = idle

    evicted = state.prune_idle_sessions(now=1e12)
    assert 'idle' in evicted
    assert 'keep' not in evicted
    assert 'idle' not in state.sessions
    assert 'keep' in state.sessions
    state.sessions.clear()
