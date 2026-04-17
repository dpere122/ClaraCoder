"""Durable checkpoint helpers, session sync, and checkpoint HTTP API."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import HumanMessage
from starlette.testclient import TestClient


def test_outer_agent_thread_id_modes() -> None:
    from nemo_backend.checkpointing import outer_agent_thread_id

    assert outer_agent_thread_id('conv-1', 'single', apply_mode=True) == 'conv-1:single:apply'
    assert outer_agent_thread_id('conv-1', 'single', apply_mode=False) == 'conv-1:single:read'


@pytest.mark.asyncio(loop_scope='function')
async def test_delete_outer_threads_clears_stable_thread(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('NEMO_CHECKPOINT_DB', str(tmp_path / 'cp.sqlite'))
    from nemo_backend.checkpointing import (
        delete_outer_threads_for_session,
        get_graph_checkpointer,
        init_graph_checkpointing,
        outer_agent_thread_id,
        shutdown_graph_checkpointing,
    )

    await init_graph_checkpointing()
    try:
        llm = FakeListChatModel(responses=['ok'])
        g = create_agent(llm, [], system_prompt='sys', name='t', checkpointer=get_graph_checkpointer())
        tid = outer_agent_thread_id('s-del', 'single', apply_mode=True)
        cfg = {'configurable': {'thread_id': tid}}
        await g.ainvoke({'messages': [HumanMessage('hello')]}, cfg)
        st = await g.aget_state(cfg)
        assert st.values and st.values.get('messages')

        await delete_outer_threads_for_session('s-del')
        st2 = await g.aget_state(cfg)
        assert not (st2.values and st2.values.get('messages'))
    finally:
        await shutdown_graph_checkpointing()


@pytest.mark.asyncio(loop_scope='function')
async def test_second_turn_uses_delta_input_no_duplicate_users(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Stable thread + delta-only second invoke should not replay first user message."""
    monkeypatch.setenv('NEMO_CHECKPOINT_DB', str(tmp_path / 'cp2.sqlite'))
    from nemo_backend.checkpointing import (
        get_graph_checkpointer,
        init_graph_checkpointing,
        outer_agent_thread_id,
        shutdown_graph_checkpointing,
    )

    await init_graph_checkpointing()
    try:
        llm = FakeListChatModel(responses=['r1', 'r2'])
        g = create_agent(llm, [], system_prompt='sys', name='t', checkpointer=get_graph_checkpointer())
        tid = outer_agent_thread_id('s2', 'single', apply_mode=False)
        cfg = {'configurable': {'thread_id': tid}}
        await g.ainvoke({'messages': [HumanMessage('first')]}, cfg)
        await g.ainvoke({'messages': [HumanMessage('second')]}, cfg)
        final = await g.aget_state(cfg)
        msgs = final.values.get('messages') or []
        human_contents = [m.content for m in msgs if getattr(m, 'type', None) == 'human']
        assert human_contents.count('first') == 1
        assert 'second' in human_contents
    finally:
        await shutdown_graph_checkpointing()


@patch('nemo_backend.routes_checkpoint.build_nemo_single_outer_graph')
@patch('nemo_backend.routes_checkpoint.build_llm')
def test_checkpoint_history_endpoint_returns_entries(
    mock_build_llm: MagicMock,
    mock_build_graph: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setenv('NEMO_CHECKPOINT_DB', str(tmp_path / 'cp3.sqlite'))
    mock_build_llm.return_value = MagicMock()

    mock_graph = MagicMock()

    async def _hist(*_a, **_k):
        snap = MagicMock()
        snap.config = {'configurable': {'checkpoint_id': 'c1', 'thread_id': 'tid'}}
        snap.next = ('model',)
        yield snap

    mock_graph.aget_state_history = _hist
    mock_build_graph.return_value = mock_graph

    from nemo_backend.main import app

    with TestClient(app) as client:
        r = client.get('/checkpoint/history', params={'session_id': 'hist-s', 'apply_mode': 'true'})
        assert r.status_code == 200
        data = r.json()
        assert data['session_id'] == 'hist-s'
        assert data['apply_mode'] is True
        assert len(data['entries']) == 1
        assert data['entries'][0]['checkpoint_id'] == 'c1'


@patch('nemo_backend.routes_session.delete_outer_threads_for_session', new_callable=AsyncMock)
def test_load_session_deletes_checkpoint_threads(
    mock_delete: AsyncMock, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv('NEMO_CHECKPOINT_DB', str(tmp_path / 'cp4.sqlite'))
    from nemo_backend.main import app

    with TestClient(app) as client:
        r = client.post('/load', json={'session_id': 'ld', 'messages': [{'role': 'user', 'content': 'a'}]})
        assert r.status_code == 200
    mock_delete.assert_awaited_once()


@patch('nemo_backend.routes_session.delete_outer_threads_for_session', new_callable=AsyncMock)
def test_clear_session_deletes_checkpoint_threads(
    mock_delete: AsyncMock, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv('NEMO_CHECKPOINT_DB', str(tmp_path / 'cp5.sqlite'))
    from nemo_backend.main import app

    with TestClient(app) as client:
        r = client.post('/clear', json={'session_id': 'cl'})
        assert r.status_code == 200
    mock_delete.assert_awaited_once()
