"""Durable checkpoint helpers, session sync, and checkpoint HTTP API."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import HumanMessage
from starlette.testclient import TestClient


def test_outer_agent_thread_id_modes() -> None:
    from clara_coder_backend.session.checkpointing import outer_agent_thread_id

    assert outer_agent_thread_id('conv-1', 'single', apply_mode=True) == 'conv-1:single:apply'
    assert outer_agent_thread_id('conv-1', 'single', apply_mode=False) == 'conv-1:single:read'


@pytest.mark.asyncio(loop_scope='function')
async def test_delete_outer_threads_clears_stable_thread(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp.sqlite'))
    from clara_coder_backend.session.checkpointing import (
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
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp2.sqlite'))
    from clara_coder_backend.session.checkpointing import (
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


@patch('clara_coder_backend.routes.checkpoint.build_clara_single_outer_graph')
@patch('clara_coder_backend.routes.checkpoint.build_llm')
def test_checkpoint_history_endpoint_returns_entries(
    mock_build_llm: MagicMock,
    mock_build_graph: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp3.sqlite'))
    mock_build_llm.return_value = MagicMock()

    mock_graph = MagicMock()

    async def _hist(*_a, **_k):
        snap = MagicMock()
        snap.config = {'configurable': {'checkpoint_id': 'c1', 'thread_id': 'tid'}}
        snap.next = ('model',)
        yield snap

    mock_graph.aget_state_history = _hist
    mock_build_graph.return_value = mock_graph

    from clara_coder_backend.main import app

    with TestClient(app) as client:
        r = client.get('/checkpoint/history', params={'session_id': 'hist-s', 'apply_mode': 'true'})
        assert r.status_code == 200
        data = r.json()
        assert data['session_id'] == 'hist-s'
        assert data['apply_mode'] is True
        assert len(data['entries']) == 1
        assert data['entries'][0]['checkpoint_id'] == 'c1'


@patch(
    'clara_coder_backend.routes.session.delete_outer_threads_for_session',
    new_callable=AsyncMock,
    return_value=None,
)
def test_load_session_deletes_checkpoint_threads(
    mock_delete: AsyncMock, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp4.sqlite'))
    from clara_coder_backend.domain import SessionState
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    state.sessions['ld'] = SessionState()
    state.sessions['ld'].pending_delete_request = {'request_id': 'x'}

    with TestClient(app) as client:
        r = client.post('/load', json={'session_id': 'ld', 'messages': [{'role': 'user', 'content': 'a'}]})
        assert r.status_code == 200
    mock_delete.assert_awaited_once_with('ld', keep_matching=None)
    assert r.json() == {'ok': True}
    assert state.sessions['ld'].history == [{'role': 'user', 'content': 'a'}]
    assert state.sessions['ld'].pending_delete_request is None


@patch('clara_coder_backend.session.lifecycle.delete_outer_threads_for_session', new_callable=AsyncMock)
def test_clear_session_deletes_checkpoint_threads(
    mock_delete: AsyncMock, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp5.sqlite'))
    from clara_coder_backend.main import app

    with TestClient(app) as client:
        r = client.post('/clear', json={'session_id': 'cl'})
        assert r.status_code == 200
    mock_delete.assert_awaited_once()


@patch('clara_coder_backend.session.lifecycle.delete_outer_threads_for_session', new_callable=AsyncMock)
def test_dispose_session_pops_and_deletes_checkpoints(
    mock_delete: AsyncMock, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp6.sqlite'))
    from clara_coder_backend.domain import SessionState
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    state.sessions['disp'] = SessionState()
    with TestClient(app) as client:
        r = client.post('/dispose', json={'session_id': 'disp'})
        assert r.status_code == 200
    mock_delete.assert_awaited_once()
    assert 'disp' not in state.sessions


@pytest.mark.asyncio(loop_scope='function')
async def test_load_clears_seeded_checkpoint_messages(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp7.sqlite'))
    from clara_coder_backend.routes.session import load_session
    from clara_coder_backend.session.checkpointing import (
        get_graph_checkpointer,
        init_graph_checkpointing,
        outer_agent_thread_id,
        shutdown_graph_checkpointing,
    )
    from clara_coder_backend.session.schemas import LoadRequest
    from clara_coder_backend.session import state

    await init_graph_checkpointing()
    try:
        llm = FakeListChatModel(responses=['ok'])
        g = create_agent(llm, [], system_prompt='sys', name='t', checkpointer=get_graph_checkpointer())
        tid = outer_agent_thread_id('s-load', 'single', apply_mode=True)
        cfg = {'configurable': {'thread_id': tid}}
        await g.ainvoke({'messages': [HumanMessage('hello')]}, cfg)
        assert (await g.aget_state(cfg)).values.get('messages')

        result = await load_session(
            LoadRequest(session_id='s-load', messages=[{'role': 'user', 'content': 'from-sqlite'}]),
        )
        assert result == {'ok': True}
        assert state.sessions['s-load'].history == [{'role': 'user', 'content': 'from-sqlite'}]
        st2 = await g.aget_state(cfg)
        assert not (st2.values and st2.values.get('messages'))
    finally:
        await shutdown_graph_checkpointing()


def _agent_with_usage(replies: list[str], input_tokens: int):
    """Outer-agent stand-in whose replies carry usage metadata (like the OpenAI-compatible client)."""
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from clara_coder_backend.session.checkpointing import get_graph_checkpointer

    llm = GenericFakeChatModel(
        messages=iter(
            AIMessage(
                content=text,
                usage_metadata={'input_tokens': input_tokens, 'output_tokens': 5, 'total_tokens': input_tokens + 5},
            )
            for text in replies
        )
    )
    return create_agent(llm, [], system_prompt='sys', name='t', checkpointer=get_graph_checkpointer())


def _history(*turns: str) -> list[dict]:
    rows: list[dict] = []
    for i, text in enumerate(turns):
        rows += [{'role': 'user', 'content': text}, {'role': 'assistant', 'content': f'reply {i}'}]
    return rows


def test_history_fingerprint_matches_load_shaped_rows() -> None:
    """Composer history and ``/load``-normalized rows of the same turns fingerprint the same."""
    from clara_coder_backend.routes.session import _load_message_content
    from clara_coder_backend.session.chat_input import effective_user_message_content
    from clara_coder_backend.session.checkpointing import history_fingerprint

    blocks = [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AA=='}}]
    live = [
        {'role': 'user', 'content': 'first'},
        {'role': 'assistant', 'content': 'ok'},
        {'role': 'user', 'content': effective_user_message_content('look at this', blocks)},
        {'role': 'assistant', 'content': 'seen'},
    ]
    loaded_rows = [
        {'role': 'user', 'message': 'first'},
        {'role': 'assistant', 'content': 'ok'},
        {'role': 'user', 'message': 'look at this', 'structuredContent': blocks},
        {'role': 'assistant', 'content': 'seen'},
    ]
    loaded = [{'role': r['role'], 'content': _load_message_content(r, r['role'])} for r in loaded_rows]
    assert history_fingerprint(live) == history_fingerprint(loaded)
    assert history_fingerprint(live)[0] == 2
    assert history_fingerprint(live) != history_fingerprint(live[:2])
    assert history_fingerprint([]) == (0, '')


@pytest.mark.asyncio(loop_scope='function')
async def test_load_keeps_a_settled_checkpoint_that_matches(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'keep.sqlite'))
    from clara_coder_backend.routes.session import load_session
    from clara_coder_backend.session.checkpointing import (
        init_graph_checkpointing,
        outer_agent_thread_id,
        settle_outer_thread,
        shutdown_graph_checkpointing,
    )
    from clara_coder_backend.session.schemas import LoadRequest

    await init_graph_checkpointing()
    try:
        g = _agent_with_usage(['r1', 'r2'], input_tokens=900)
        cfg = {'configurable': {'thread_id': outer_agent_thread_id('s-keep', 'single', apply_mode=True)}}
        await g.ainvoke({'messages': [HumanMessage('one')]}, cfg)
        await g.ainvoke({'messages': [HumanMessage('two')]}, cfg)
        await settle_outer_thread('s-keep', apply_mode=True, history=_history('one', 'two'), freed_tokens=100)

        loaded = [
            {'role': 'user', 'message': 'one'},
            {'role': 'assistant', 'content': 'reply 0'},
            {'role': 'user', 'message': 'two'},
            {'role': 'assistant', 'content': 'reply 1'},
        ]
        result = await load_session(LoadRequest(session_id='s-keep', messages=loaded, keep_matching_checkpoint=True))
        assert result == {'ok': True, 'kept_checkpoint': True, 'context_tokens': 800}
        kept = (await g.aget_state(cfg)).values.get('messages')
        assert [m.content for m in kept] == ['one', 'r1', 'two', 'r2']

        # One turn fewer (a crash before Electron saved the last turn): rebuilt from text.
        result = await load_session(
            LoadRequest(session_id='s-keep', messages=loaded[:2], keep_matching_checkpoint=True)
        )
        assert result == {'ok': True}
        assert not (await g.aget_state(cfg)).values.get('messages')
    finally:
        await shutdown_graph_checkpointing()


@pytest.mark.asyncio(loop_scope='function')
async def test_load_drops_a_thread_whose_turn_never_settled(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """A turn that started but never settled (the app quit mid-turn) leaves no row to match."""
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'unsettled.sqlite'))
    from clara_coder_backend.routes.session import load_session
    from clara_coder_backend.session.checkpointing import (
        forget_outer_thread_sync,
        init_graph_checkpointing,
        outer_agent_thread_id,
        settle_outer_thread,
        shutdown_graph_checkpointing,
    )
    from clara_coder_backend.session.schemas import LoadRequest

    await init_graph_checkpointing()
    try:
        g = _agent_with_usage(['r1', 'partial'], input_tokens=50)
        cfg = {'configurable': {'thread_id': outer_agent_thread_id('s-uns', 'single', apply_mode=True)}}
        await g.ainvoke({'messages': [HumanMessage('one')]}, cfg)
        await settle_outer_thread('s-uns', apply_mode=True, history=_history('one'))
        await forget_outer_thread_sync('s-uns')
        await g.ainvoke({'messages': [HumanMessage('unsaved')]}, cfg)

        result = await load_session(
            LoadRequest(session_id='s-uns', messages=_history('one'), keep_matching_checkpoint=True)
        )
        assert result == {'ok': True}
        assert not (await g.aget_state(cfg)).values.get('messages')
    finally:
        await shutdown_graph_checkpointing()


@pytest.mark.asyncio(loop_scope='function')
async def test_load_without_keep_flag_still_deletes(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """A timeline restore resyncs without the flag: even a matching checkpoint goes."""
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'nokeep.sqlite'))
    from clara_coder_backend.routes.session import load_session
    from clara_coder_backend.session.checkpointing import (
        init_graph_checkpointing,
        outer_agent_thread_id,
        settle_outer_thread,
        shutdown_graph_checkpointing,
    )
    from clara_coder_backend.session.schemas import LoadRequest

    await init_graph_checkpointing()
    try:
        g = _agent_with_usage(['r1'], input_tokens=50)
        cfg = {'configurable': {'thread_id': outer_agent_thread_id('s-nokeep', 'single', apply_mode=False)}}
        await g.ainvoke({'messages': [HumanMessage('one')]}, cfg)
        await settle_outer_thread('s-nokeep', apply_mode=False, history=_history('one'))

        result = await load_session(LoadRequest(session_id='s-nokeep', messages=_history('one')))
        assert result == {'ok': True}
        assert not (await g.aget_state(cfg)).values.get('messages')
    finally:
        await shutdown_graph_checkpointing()


@pytest.mark.asyncio(loop_scope='function')
async def test_settle_prunes_old_checkpoints_and_drops_other_mode(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'settle.sqlite'))
    from clara_coder_backend.session import checkpointing
    from clara_coder_backend.session.checkpointing import (
        init_graph_checkpointing,
        outer_agent_thread_id,
        settle_outer_thread,
        shutdown_graph_checkpointing,
    )

    await init_graph_checkpointing()
    try:
        read_cfg = {'configurable': {'thread_id': outer_agent_thread_id('s-st', 'single', apply_mode=False)}}
        apply_tid = outer_agent_thread_id('s-st', 'single', apply_mode=True)
        apply_cfg = {'configurable': {'thread_id': apply_tid}}
        await _agent_with_usage(['old'], input_tokens=10).ainvoke({'messages': [HumanMessage('zero')]}, read_cfg)
        g = _agent_with_usage(['r1', 'r2'], input_tokens=10)
        await g.ainvoke({'messages': [HumanMessage('one')]}, apply_cfg)
        await g.ainvoke({'messages': [HumanMessage('two')]}, apply_cfg)

        async def checkpoint_rows(tid: str) -> int:
            async with checkpointing._conn.execute(
                'SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?', (tid,)
            ) as cur:
                return (await cur.fetchone())[0]

        assert await checkpoint_rows(apply_tid) > 1
        await settle_outer_thread('s-st', apply_mode=True, history=_history('zero', 'one', 'two'))

        assert await checkpoint_rows(apply_tid) == 1
        assert [m.content for m in (await g.aget_state(apply_cfg)).values['messages']] == ['one', 'r1', 'two', 'r2']
        # The read thread never saw this turn: gone, so its next turn rebuilds from history.
        assert not (await g.aget_state(read_cfg)).values.get('messages')
    finally:
        await shutdown_graph_checkpointing()


@pytest.mark.asyncio(loop_scope='function')
async def test_compact_checkpoint_db_keeps_latest_per_thread(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'compact.sqlite'))
    from clara_coder_backend.session import checkpointing
    from clara_coder_backend.session.checkpointing import (
        compact_checkpoint_db,
        init_graph_checkpointing,
        shutdown_graph_checkpointing,
    )

    await init_graph_checkpointing()
    try:
        g = _agent_with_usage(['a1', 'a2', 'b1'], input_tokens=10)
        cfg_a = {'configurable': {'thread_id': 'ta'}}
        cfg_b = {'configurable': {'thread_id': 'tb'}}
        await g.ainvoke({'messages': [HumanMessage('a')]}, cfg_a)
        await g.ainvoke({'messages': [HumanMessage('aa')]}, cfg_a)
        await g.ainvoke({'messages': [HumanMessage('b')]}, cfg_b)
        before_a = (await g.aget_state(cfg_a)).values['messages']

        await compact_checkpoint_db()

        async with checkpointing._conn.execute(
            'SELECT thread_id, COUNT(*) FROM checkpoints GROUP BY thread_id ORDER BY thread_id'
        ) as cur:
            assert [tuple(r) for r in await cur.fetchall()] == [('ta', 1), ('tb', 1)]
        assert (await g.aget_state(cfg_a)).values['messages'] == before_a
        assert [m.content for m in (await g.aget_state(cfg_b)).values['messages']] == ['b', 'b1']
    finally:
        await shutdown_graph_checkpointing()


@pytest.mark.asyncio(loop_scope='function')
async def test_vacuum_runs_while_another_write_is_uncommitted(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """The startup VACUUM shares the connection with turns: an open write must not make it fail."""
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'vacuum.sqlite'))
    from clara_coder_backend.session import checkpointing
    from clara_coder_backend.session.checkpointing import init_graph_checkpointing, shutdown_graph_checkpointing

    await init_graph_checkpointing()
    try:
        await checkpointing._conn.execute(
            f'INSERT INTO {checkpointing.SYNC_TABLE} (thread_id, user_turns, last_user_digest) VALUES (?, ?, ?)',
            ('t', 1, 'd'),
        )
        assert checkpointing._conn.in_transaction
        assert await checkpointing._vacuum() is True
    finally:
        await shutdown_graph_checkpointing()
