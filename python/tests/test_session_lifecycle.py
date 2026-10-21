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


def test_session_admin_elevation_grant_and_revoke(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'life-admin.sqlite'))
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    with TestClient(app) as client:
        sid = 'admin-chip'
        state.get_session(sid)
        with patch(
            'clara_coder_backend.runtime.admin_exec.warmup_persistent_broker',
            new_callable=AsyncMock,
            return_value=None,
        ) as warmup:
            on = client.post('/session/admin-elevation', json={'session_id': sid, 'granted': True})
        assert on.status_code == 200
        assert on.json()['granted'] is True
        assert state.get_session(sid).admin_elevation_granted is True
        warmup.assert_awaited_once_with(sid)

        with patch(
            'clara_coder_backend.runtime.admin_exec.shutdown_session_broker',
            new_callable=AsyncMock,
        ) as shutdown:
            off = client.post('/session/admin-elevation', json={'session_id': sid, 'granted': False})
        assert off.status_code == 200
        assert off.json()['granted'] is False
        assert state.get_session(sid).admin_elevation_granted is False
        shutdown.assert_awaited()


def test_session_admin_elevation_grant_fails_when_helper_cancelled(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'life-admin-cancel.sqlite'))
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    with TestClient(app) as client:
        sid = 'admin-cancel'
        state.get_session(sid)
        with patch(
            'clara_coder_backend.runtime.admin_exec.warmup_persistent_broker',
            new_callable=AsyncMock,
            return_value='User cancelled the administrator prompt.',
        ):
            on = client.post('/session/admin-elevation', json={'session_id': sid, 'granted': True})
        assert on.status_code == 200
        assert on.json()['ok'] is False
        assert on.json()['granted'] is False
        assert 'cancelled' in str(on.json().get('error', '')).lower()
        assert state.get_session(sid).admin_elevation_granted is False


def test_load_preserves_admin_elevation_grant(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'life-admin-load.sqlite'))
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    with patch('clara_coder_backend.routes.session.delete_outer_threads_for_session', new_callable=AsyncMock):
        with TestClient(app) as client:
            sid = 'admin-load'
            state.get_session(sid).admin_elevation_granted = True
            r = client.post('/load', json={'session_id': sid, 'messages': [{'role': 'user', 'message': 'hi'}]})
            assert r.status_code == 200
            assert state.get_session(sid).admin_elevation_granted is True
            assert state.get_session(sid).pending_accept_command_request is None


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


def test_prune_idle_sessions_is_reentrant_when_cleanup_calls_get_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Eviction cleanup may call ``get_session``; above the prune threshold that
    used to recurse (get_session -> prune -> cleanup -> get_session -> ...)."""

    from clara_coder_backend.domain import SessionState
    from clara_coder_backend.session import state
    from clara_coder_backend.workspace_index import lifecycle as index_lifecycle

    state.sessions.clear()
    state.current_session_id.set('')
    monkeypatch.setattr(state, 'SESSION_PRUNE_THRESHOLD', 2)
    for index in range(5):
        idle = SessionState()
        idle.last_touched = 1.0
        state.sessions[f'idle-{index}'] = idle

    cleanup_calls: list[str] = []

    def _cleanup_via_get_session(sid: str) -> None:
        cleanup_calls.append(sid)
        # Eviction cleanup that re-enters get_session while pruning.
        state.get_session(sid)

    monkeypatch.setattr(index_lifecycle, 'invalidate_staging_index_disk', _cleanup_via_get_session)
    try:
        fresh = state.get_session('fresh')
        assert fresh is state.sessions['fresh']
        assert len(cleanup_calls) == 5
        assert not any(sid.startswith('idle-') for sid in state.sessions)
        assert state._pruning is False
    finally:
        state.sessions.clear()


@pytest.mark.asyncio(loop_scope='function')
async def test_dispose_stops_the_turn_and_running_subagents_before_teardown(monkeypatch: pytest.MonkeyPatch) -> None:
    """``/dispose`` of a parent aborts its sub-agents and waits for them; a child id is never recreated."""
    import asyncio

    from clara_coder_backend.lang_agent.subagents import fork_subagent_session, is_subagent_session_id
    from clara_coder_backend.routes.session import dispose_session
    from clara_coder_backend.session import state
    from clara_coder_backend.session.schemas import ClearRequest

    teardown = AsyncMock()
    monkeypatch.setattr('clara_coder_backend.routes.session.teardown_session', teardown)
    parent = state.get_session('disp-parent')
    child = fork_subagent_session('disp-parent', parent, 'disp-child', 'x')
    ended: list[str] = []

    async def child_turn() -> None:
        await child.abort_event.wait()
        ended.append('child')
        parent.subagent_children.pop('disp-child', None)
        state.sessions.pop('disp-child', None)

    parent.subagent_children['disp-child'] = asyncio.get_running_loop().create_task(child_turn())
    try:
        await asyncio.wait_for(dispose_session(ClearRequest(session_id='disp-parent')), timeout=5)

        assert ended == ['child'] and child.subagent_cancel_requested
        assert 'disp-parent' not in state.sessions
        teardown.assert_awaited_once_with('disp-parent')

        # A sub-agent id that is gone stays gone: ``/clear`` does not recreate it as a main session.
        from clara_coder_backend.lang_agent.subagents import schedule_subagent_teardown
        from clara_coder_backend.routes.session import clear_session

        schedule_subagent_teardown('disp-child')
        await asyncio.sleep(0)
        assert is_subagent_session_id('disp-child')
        await clear_session(ClearRequest(session_id='disp-child'))
        assert 'disp-child' not in state.sessions
    finally:
        state.sessions.pop('disp-child', None)
        state.sessions.pop('disp-parent', None)
