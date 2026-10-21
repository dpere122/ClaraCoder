"""Sub-agents: session fork, tool sets, the event bus contract, ownership, report delivery, stops and routes.

The end-to-end tests run the real Clara graph (real middleware, real checkpointer) with a scripted chat
model: the parent and each sub-agent (told apart by the sub-agent prompt block) follow their own script.
Sub-agent events are read from the process-wide bus; the parent's ``/chat/stream`` lines from the composer.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest
import pytest_asyncio
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from clara_coder_backend.composer import stream_agent_reply
from clara_coder_backend.domain import SessionState
from clara_coder_backend.hitl.tool_registry import worker_tools_and_map
from clara_coder_backend.lang_agent import subagents
from clara_coder_backend.lang_agent.subagent_bus import SUBAGENT_BUS
from clara_coder_backend.lang_agent.subagents import (
    NO_NEW_REPORTS_TEXT,
    REPORTS_ARRIVED_HEADER,
    SubagentReport,
    SubagentRun,
    abort_subagent,
    fork_subagent_session,
    is_subagent_session_id,
)
from clara_coder_backend.llm.messages import build_system_prompt
from clara_coder_backend.session import state
from clara_coder_backend.session.schemas import AgentContinueRequest, SessionAutoApplyRequest

pytestmark = pytest.mark.asyncio(loop_scope='function')

_HANG = object()


class ScriptedChatModel(BaseChatModel):
    """Replies from per-agent scripts: ``parent``, or the sub-agent's name from its prompt block.

    A reply given as ``(message, gate)`` streams its first word, then waits: forever for ``_HANG``
    (until aborted), else until the ``asyncio.Event`` gate is set.
    """

    scripts: dict[str, list[Any]]
    seen: list[tuple[str, list[Any]]] = []

    def bind_tools(self, tools: Any, **_kwargs: Any) -> ScriptedChatModel:
        return self

    @property
    def _llm_type(self) -> str:
        return 'scripted'

    @staticmethod
    def agent_key(messages: list[Any]) -> str:
        system = messages[0].content if messages and isinstance(messages[0], SystemMessage) else ''
        found = re.search(r'sub-agent\*\* named `([^`]+)`', str(system))
        return found.group(1) if found else 'parent'

    def _generate(self, messages: list[Any], stop: Any = None, run_manager: Any = None, **_kwargs: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self.scripts[self.agent_key(messages)].pop(0))])

    async def _astream(
        self, messages: list[Any], stop: Any = None, run_manager: Any = None, **_kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        key = self.agent_key(messages)
        self.seen.append((key, list(messages)))
        reply = self.scripts[key].pop(0)
        gate = reply[1] if isinstance(reply, tuple) else None
        msg: AIMessage = reply[0] if isinstance(reply, tuple) else reply
        words = str(msg.content).split(' ') if msg.content else []
        for index, word in enumerate(words):
            chunk = ChatGenerationChunk(message=AIMessageChunk(content=f'{word} '))
            if run_manager is not None:
                await run_manager.on_llm_new_token(f'{word} ', chunk=chunk)
            yield chunk
            if gate is not None and index == 0:
                await (asyncio.Future() if gate is _HANG else gate.wait())
        if msg.tool_calls:
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content='',
                    tool_call_chunks=[
                        {'name': call['name'], 'args': json.dumps(call['args']), 'id': call['id'], 'index': i}
                        for i, call in enumerate(msg.tool_calls)
                    ],
                )
            )

    def views(self, key: str = 'parent') -> list[list[Any]]:
        return [msgs for k, msgs in self.seen if k == key]


def _spawn(call_id: str, name: str, task: str, *, background: bool = False) -> dict[str, Any]:
    args: dict[str, Any] = {'task': task, 'name': name}
    if background:
        args['background'] = True
    return {'name': 'spawn_subagent', 'args': args, 'id': call_id}


def _call(call_id: str, tool_name: str, **args: Any) -> dict[str, Any]:
    return {'name': tool_name, 'args': args, 'id': call_id}


def _payloads(lines: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in lines:
        body = line.removeprefix('data: ').strip()
        if body and body != '[DONE]':
            out.append(json.loads(body))
    return out


def _texts(messages: list[Any]) -> list[str]:
    return [str(m.content) for m in messages]


class BusTap:
    """A test subscriber on the sub-agent bus."""

    def __init__(self) -> None:
        self.queue = SUBAGENT_BUS.subscribe()
        self.seen: list[dict[str, Any]] = []

    def events(self) -> list[dict[str, Any]]:
        while True:
            try:
                self.seen.append(self.queue.get_nowait())
            except asyncio.QueueEmpty:
                return list(self.seen)

    def of(self, child_id: str) -> list[dict[str, Any]]:
        return [e for e in self.events() if e.get('conversation_id') == child_id]

    def child(self, name: str) -> str:
        return next(e['conversation_id'] for e in self.events() if e['type'] == 'subagent_started' and e['name'] == name)

    def started(self, name: str) -> bool:
        return any(e['type'] == 'subagent_started' and e['name'] == name for e in self.events())

    def finished(self, name: str) -> str | None:
        if not self.started(name):
            return None
        cid = self.child(name)
        return next((e['outcome'] for e in self.of(cid) if e['type'] == 'subagent_finished'), None)

    def child_text(self, name: str) -> str:
        return ''.join(
            e['payload'].get('delta', '')
            for e in self.of(self.child(name))
            if e['type'] == 'subagent_event' and e['payload'].get('type') == 'chunk'
        )

    def ready(self) -> list[dict[str, Any]]:
        return [e for e in self.events() if e['type'] == 'subagent_results_ready']


@pytest_asyncio.fixture(loop_scope='function')
async def checkpoints(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'subagents.sqlite'))
    from clara_coder_backend.session.checkpointing import init_graph_checkpointing, shutdown_graph_checkpointing

    await init_graph_checkpointing()
    yield
    # Sub-agents outlive their turns: stop the ones a test left running before the checkpointer goes.
    await subagents.stop_all_subagents()
    await asyncio.sleep(0.05)  # let teardown tasks finish before the connection closes
    await shutdown_graph_checkpointing()


@pytest.fixture()
def bus():
    tap = BusTap()
    yield tap
    SUBAGENT_BUS.unsubscribe(tap.queue)


@pytest.fixture()
def parent_session(tmp_path):
    sid = 'sub-parent'
    state.sessions.pop(sid, None)
    workspace = tmp_path / 'ws'
    workspace.mkdir()
    sess = state.get_session(sid)
    sess.workspace_path = str(workspace)
    yield sid, sess
    for cid in [k for k, s in state.sessions.items() if s.subagent_parent_session_id == sid]:
        state.sessions.pop(cid, None)
    state.sessions.pop(sid, None)


@pytest.fixture()
def use_model(monkeypatch: pytest.MonkeyPatch) -> Callable[[ScriptedChatModel], ScriptedChatModel]:
    """Patch the model for the whole test: sub-agents may outlive the turn that started them."""

    def install(model: ScriptedChatModel) -> ScriptedChatModel:
        monkeypatch.setattr('clara_coder_backend.lang_agent.graph.build_llm', lambda *a, **k: model)
        monkeypatch.setattr('clara_coder_backend.composer.build_llm', lambda *a, **k: model)
        return model

    return install


async def _run_turn(sid: str, text: str, **kwargs: Any) -> list[str]:
    umid = kwargs.pop('umid', 'u1')
    return [line async for line in stream_agent_reply(sid, text, user_message_id=umid, **kwargs)]


def _start_turn(sid: str, text: str, lines: list[str], **kwargs: Any) -> asyncio.Task:
    umid = kwargs.pop('umid', 'u1')

    async def consume() -> None:
        async for line in stream_agent_reply(sid, text, user_message_id=umid, **kwargs):
            lines.append(line)

    return asyncio.create_task(consume())


async def _wait_for(predicate: Callable[[], Any], timeout: float = 8.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError('condition not reached')
        await asyncio.sleep(0.02)


def _pill(lines: list[str], label: str) -> list[dict[str, Any]]:
    return [p['status'] for p in _payloads(lines) if p['type'] == 'status' and p['status'].get('label') == label]


# ---------------------------------------------------------------------------
# Fork, tool sets, prompt, names
# ---------------------------------------------------------------------------


async def test_fork_shares_lsp_and_edits_and_copies_workspace() -> None:
    parent = SessionState(workspace_path='/ws', workspace_id='w1', auto_apply_mode=True)
    parent.semantic_index_pending.append(('a.py', 'change'))
    parent.admin_elevation_granted = True
    parent.current_user_message_id = 'turn-7'
    try:
        child = fork_subagent_session('p', parent, 'child-1', 'scout')

        assert state.sessions['child-1'] is child
        assert child.lsp is parent.lsp and child.edits is parent.edits
        assert child.workspace is not parent.workspace
        assert child.workspace_path == '/ws' and child.workspace_id == 'w1'
        assert child.semantic_index_pending == []
        assert child.auto_apply_mode is True and child.admin_elevation_granted is False
        assert child.current_user_message_id == 'turn-7'
        assert child.subagent_parent_session_id == 'p' and child.subagent_name == 'scout'
        assert child.last_touched > 0
        assert is_subagent_session_id('child-1') and not is_subagent_session_id('p')
    finally:
        state.sessions.pop('child-1', None)


async def test_tool_sets_bind_the_subagent_tools_for_main_chat_only() -> None:
    main = SessionState()
    child = SessionState()
    child.subagent_parent_session_id = 'p'
    family = {'spawn_subagent', 'wait_for_subagents', 'stop_subagent'}

    def names(apply_mode: bool, sess: SessionState, flag: bool) -> set[str]:
        tools, _ = worker_tools_and_map(apply_mode, session=sess, include_subagent_tool=flag)
        return {t.name for t in tools}

    for apply_mode in (False, True):
        assert family | {'propose_theme'} <= names(apply_mode, main, True)
        assert not family & names(apply_mode, main, False)
        assert not (family | {'propose_theme'}) & names(apply_mode, child, True)


async def test_subagent_prompt_has_role_block() -> None:
    child = SessionState()
    child.subagent_parent_session_id = 'p'
    child.subagent_name = 'scout'
    assert 'You are a sub-agent** named `scout`' in build_system_prompt(child, False)
    assert 'You are a sub-agent' not in build_system_prompt(SessionState(), False)


def _fake_run(parent_sid: str, parent: SessionState, child_id: str, name: str, **kwargs: Any) -> SubagentRun:
    run = SubagentRun(
        parent_session_id=parent_sid,
        parent=parent,
        child_id=child_id,
        child=SessionState(),
        name=name,
        task_text='t',
        **kwargs,
    )
    subagents.register_subagent_run(run)
    return run


async def test_names_are_unique_among_live_subagents_and_waiting_reports() -> None:
    parent = SessionState()
    _fake_run('p', parent, 'c1', 'scout')
    parent.subagent_pending_reports['c0'] = SubagentReport('c0', 'scout-2', 'r', 'completed')
    assert subagents.unique_subagent_name(parent, 'scout') == 'scout-3'
    assert subagents.unique_subagent_name(parent, 'other') == 'other'
    long = 'x' * subagents.SUBAGENT_NAME_MAX_CHARS
    _fake_run('p', parent, 'c2', long)
    renamed = subagents.unique_subagent_name(parent, long)
    assert renamed.endswith('-2') and len(renamed) == subagents.SUBAGENT_NAME_MAX_CHARS
    # Lookups by id or (case-insensitive) name, live runs and waiting reports alike.
    assert subagents.find_subagent(parent, 'c1').name == 'scout'
    assert subagents.find_subagent(parent, '`SCOUT-2`').child_id == 'c0'
    assert subagents.find_subagent(parent, 'nope') is None


async def test_preamble_lists_running_subagents() -> None:
    from clara_coder_backend.llm.messages import outer_turn_authority_preamble

    parent = SessionState()
    assert 'Sub-agents still running' not in outer_turn_authority_preamble(parent, True)
    run = _fake_run('p', parent, 'c1', 'scout', background=True)
    run.started_at -= 65
    _fake_run('p', parent, 'c2', 'tests').waiters = 1
    line = next(ln for ln in outer_turn_authority_preamble(parent, True).splitlines() if 'Sub-agents' in ln)
    assert '`scout` (background, 1m 05s)' in line and '`tests` (waited on, 0s)' in line


async def test_watchdog_stays_quiet_while_subagents_run() -> None:
    from clara_coder_backend.lang_agent.graph import _stream_is_genuinely_stalled
    from clara_coder_backend.lang_agent.langgraph_sse import GraphStreamState

    parent = SessionState()
    assert _stream_is_genuinely_stalled(parent, GraphStreamState())
    parent.subagent_children['c1'] = asyncio.get_running_loop().create_future()  # type: ignore[assignment]
    assert not _stream_is_genuinely_stalled(parent, GraphStreamState())


# ---------------------------------------------------------------------------
# Event bus and its route
# ---------------------------------------------------------------------------


async def test_bus_buffers_until_subscribed_and_fans_out_to_every_subscriber() -> None:
    from clara_coder_backend.lang_agent.subagent_bus import SubagentEventBus

    bus = SubagentEventBus(buffer_max=3)
    for n in range(5):
        bus.publish({'n': n})
    assert [e['n'] for e in bus.buffered()] == [2, 3, 4]  # capped, oldest dropped

    first = bus.subscribe()
    assert [first.get_nowait()['n'] for _ in range(3)] == [2, 3, 4] and bus.buffered() == []
    second = bus.subscribe()
    bus.publish({'n': 5})
    assert first.get_nowait() == second.get_nowait() == {'n': 5}

    # The last subscriber to leave hands unread events back, ahead of newer ones.
    bus.unsubscribe(first)
    bus.publish({'n': 6})
    bus.unsubscribe(second)
    bus.publish({'n': 7})
    second.put_nowait({'n': 99})  # a stale queue is never read again
    bus.unsubscribe(second)  # idempotent
    assert [e['n'] for e in bus.buffered()] == [6, 7]
    third = bus.subscribe()
    assert third.get_nowait() == {'n': 6}

    # A full buffer drops streaming detail before markers and journal rows.
    small = SubagentEventBus(buffer_max=2)
    journal = {'type': 'subagent_event', 'conversation_id': 'c', 'payload': {'type': 'file_journal'}}
    chunk = {'type': 'subagent_event', 'conversation_id': 'c', 'payload': {'type': 'chunk', 'delta': 'x'}}
    started = {'type': 'subagent_started', 'conversation_id': 'c'}
    for event in (started, chunk, journal):
        small.publish(event)
    assert small.buffered() == [started, journal]


async def test_events_route_streams_subscribed_buffered_events_and_keepalives(monkeypatch) -> None:
    from clara_coder_backend.routes import subagents as route

    monkeypatch.setattr(route, 'KEEPALIVE_SEC', 0.05)
    SUBAGENT_BUS.publish({'type': 'subagent_finished', 'conversation_id': 'c1', 'outcome': 'completed'})
    response = await route.subagent_events()
    assert response.media_type == 'text/event-stream'
    lines = response.body_iterator.__aiter__()
    assert await lines.__anext__() == 'data: {"type": "subscribed"}\n\n'
    assert json.loads((await lines.__anext__()).removeprefix('data: ')) == {
        'type': 'subagent_finished',
        'conversation_id': 'c1',
        'outcome': 'completed',
    }
    assert await lines.__anext__() == ': keepalive\n\n'
    SUBAGENT_BUS.publish({'type': 'subagent_results_ready', 'parent_conversation_id': 'p', 'names': ['a']})
    assert json.loads((await lines.__anext__()).removeprefix('data: '))['names'] == ['a']
    await lines.aclose()
    assert SUBAGENT_BUS.subscriber_count == 0
    SUBAGENT_BUS.publish({'type': 'x'})
    assert SUBAGENT_BUS.buffered() == [{'type': 'x'}]


async def test_events_route_unsubscribes_when_the_client_disconnects() -> None:
    """Starlette never closes the body iterator; the response itself must unsubscribe."""
    from starlette.requests import ClientDisconnect

    from clara_coder_backend.routes.subagents import subagent_events

    response = await subagent_events()
    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        if message['type'] == 'http.response.body' and sent:
            raise OSError('connection lost')
        sent.append(message)

    async def receive() -> dict[str, Any]:
        await asyncio.Future()
        return {}

    with pytest.raises((ClientDisconnect, OSError)):
        await response({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, send)
    assert SUBAGENT_BUS.subscriber_count == 0
    SUBAGENT_BUS.publish({'type': 'later'})
    assert SUBAGENT_BUS.buffered() == [{'type': 'later'}]


async def test_events_route_requires_the_sidecar_token(monkeypatch) -> None:
    from clara_coder_backend.main import app

    monkeypatch.setenv('CLARA_SIDECAR_TOKEN', 'tok')
    monkeypatch.delenv('CLARA_SIDECAR_AUTH_OPTIONAL', raising=False)
    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    async def receive() -> dict[str, Any]:
        return {'type': 'http.request', 'body': b'', 'more_body': False}

    scope = {'type': 'http', 'method': 'GET', 'path': '/subagents/events', 'headers': [], 'query_string': b''}
    await app.build_middleware_stack()(scope, receive, send)
    assert sent[0]['type'] == 'http.response.start' and sent[0]['status'] == 401
    assert SUBAGENT_BUS.subscriber_count == 0


# ---------------------------------------------------------------------------
# Foreground spawns: the bus contract
# ---------------------------------------------------------------------------


async def test_parallel_subagents_publish_on_the_bus_and_parent_keeps_its_stream(
    checkpoints, parent_session, bus, use_model
) -> None:
    sid, parent = parent_session
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='Delegating.', tool_calls=[_spawn('s1', 'alpha', 'look at A'), _spawn('s2', 'beta', 'look at B')]),
                    AIMessage(content='Parent final answer.'),
                ],
                'alpha': [AIMessage(content='Alpha report text.')],
                'beta': [AIMessage(content='Beta report text.')],
            }
        )
    )
    payloads = _payloads(await _run_turn(sid, 'do it', apply_mode=False, umid='turn-1'))

    # The parent's stream carries no sub-agent events, only its own (and the linked pills).
    assert not [p for p in payloads if p['type'].startswith('subagent_')]
    parent_chunks = ''.join(p['delta'] for p in payloads if p['type'] == 'chunk')
    assert 'report' not in parent_chunks and 'Parent final answer.' in parent_chunks
    assert [p['text'] for p in payloads if p['type'] == 'final_text'] == ['Parent final answer.']

    for name, task in (('alpha', 'look at A'), ('beta', 'look at B')):
        cid = bus.child(name)
        events = bus.of(cid)
        started = events[0]
        assert started['type'] == 'subagent_started' and events[-1]['type'] == 'subagent_finished'
        assert [e['type'] for e in events].count('subagent_started') == 1
        assert [e['type'] for e in events].count('subagent_finished') == 1
        assert events[-1]['outcome'] == 'completed'
        assert started['parent_conversation_id'] == sid and started['parent_turn_id'] == 'turn-1'
        assert started['task'] == task and started['background'] is False and started['status_id']
        assert re.fullmatch(r'[A-Za-z0-9_-]{8,64}', cid)
        inner = [e['payload'] for e in events if e['type'] == 'subagent_event']
        assert f'{name.capitalize()} report text.' in bus.child_text(name)
        assert {'type': 'final_text', 'text': f'{name.capitalize()} report text.'} in inner

        # The spawn pill's running update and its finished status both link the child.
        pill = [
            p['status']
            for p in payloads
            if p['type'] == 'status' and p['status']['id'] == started['status_id'] and p['status'].get('subagent')
        ]
        assert {s['state'] for s in pill} == {'running', 'complete'}
        assert all(s['subagent'] == {'conversation_id': cid, 'name': name} for s in pill)

    # The parent's next model call got each report as the spawn result, and only there.
    view = model.views()[-1]
    results = {m.tool_call_id: str(m.content) for m in view if m.type == 'tool'}
    assert 'Alpha report text.' in results['s1'] and 'finished' in results['s1']
    assert 'Beta report text.' in results['s2']
    assert not any(REPORTS_ARRIVED_HEADER in t for t in _texts(view))
    assert parent.subagent_pending_reports == {} and not bus.ready()

    await asyncio.sleep(0.05)
    assert not parent.subagent_children
    # Torn down: gone from the store, but still known as sub-agent ids so routes never recreate them.
    for name in ('alpha', 'beta'):
        cid = bus.child(name)
        assert cid not in state.sessions and is_subagent_session_id(cid)


async def test_subagent_file_journal_is_wrapped_on_the_bus_with_the_spawning_turn_id(
    checkpoints, parent_session, bus, use_model
) -> None:
    sid, _parent = parent_session
    write = _call('w1', 'write_workspace_file', relative_path='notes.txt', content='hi\n')
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn('s1', 'writer', 'create notes.txt')]),
                    AIMessage(content='Done.'),
                ],
                'writer': [AIMessage(content='', tool_calls=[write]), AIMessage(content='Created notes.txt.')],
            }
        )
    )
    payloads = _payloads(await _run_turn(sid, 'write it', apply_mode=True, umid='turn-42'))

    assert not [p for p in payloads if p['type'] == 'file_journal']
    journals = [
        e['payload'] for e in bus.of(bus.child('writer')) if e['type'] == 'subagent_event' and e['payload']['type'] == 'file_journal'
    ]
    assert len(journals) == 1
    assert journals[0]['fileJournal']['relativePath'] == 'notes.txt'
    assert journals[0]['fileJournal']['userMessageId'] == 'turn-42'
    report = next(str(m.content) for m in model.views()[-1] if m.type == 'tool')
    assert '`notes.txt`' in report


async def test_spawns_beyond_the_cap_wait_for_a_slot(checkpoints, parent_session, bus, use_model, monkeypatch) -> None:
    sid, _parent = parent_session
    monkeypatch.setattr(subagents, 'CLARA_SUBAGENT_MAX_CONCURRENCY', 1)
    use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn('s1', 'one', 'task 1'), _spawn('s2', 'two', 'task 2')]),
                    AIMessage(content='Both done.'),
                ],
                'one': [AIMessage(content='One done.')],
                'two': [AIMessage(content='Two done.')],
            }
        )
    )
    await _run_turn(sid, 'go', apply_mode=False)

    events = bus.events()
    worked = [e['conversation_id'] for e in events if e['type'] == 'subagent_event']
    first, second = worked[0], next(c for c in worked if c != worked[0])
    first_done = next(i for i, e in enumerate(events) if e['type'] == 'subagent_finished' and e['conversation_id'] == first)
    second_events = [i for i, e in enumerate(events) if e['type'] == 'subagent_event' and e['conversation_id'] == second]
    # One slot: the second sub-agent only starts working after the first one finished.
    assert second_events and min(second_events) > first_done
    assert [e['outcome'] for e in events if e['type'] == 'subagent_finished'] == ['completed', 'completed']


async def test_same_name_spawns_get_unique_names(checkpoints, parent_session, bus, use_model) -> None:
    sid, _parent = parent_session
    use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn('s1', 'scout', 'A'), _spawn('s2', 'scout', 'B')]),
                    AIMessage(content='ok'),
                ],
                'scout': [AIMessage(content='first')],
                'scout-2': [AIMessage(content='second')],
            }
        )
    )
    await _run_turn(sid, 'go', apply_mode=False)
    assert sorted(e['name'] for e in bus.events() if e['type'] == 'subagent_started') == ['scout', 'scout-2']


# ---------------------------------------------------------------------------
# Background spawns and report delivery
# ---------------------------------------------------------------------------


async def test_background_spawn_returns_at_once_and_its_report_arrives_before_the_next_model_call_once(
    checkpoints, parent_session, bus, use_model
) -> None:
    sid, parent = parent_session
    child_gate, parent_gate = asyncio.Event(), asyncio.Event()
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn('s1', 'scout', 'look around', background=True)]),
                    (AIMessage(content='Meanwhile listing.', tool_calls=[_call('l1', 'list_workspace_directory')]), parent_gate),
                    AIMessage(content='Final with the report.'),
                ],
                'scout': [(AIMessage(content='Scout found things.'), child_gate)],
            }
        )
    )
    lines: list[str] = []
    turn = _start_turn(sid, 'go', lines, apply_mode=False)

    # The spawn call already returned while the sub-agent still works.
    await _wait_for(lambda: len(model.views()) == 2)
    spawn_result = next(str(m.content) for m in model.views()[1] if m.type == 'tool')
    assert spawn_result.startswith('Started sub-agent `scout` in the background (id ')
    assert bus.finished('scout') is None

    child_gate.set()
    await _wait_for(lambda: bus.finished('scout') == 'completed')
    parent_gate.set()
    await asyncio.wait_for(turn, timeout=10)

    final_view = model.views()[-1]
    delivered = [t for t in _texts(final_view) if REPORTS_ARRIVED_HEADER in t]
    assert len(delivered) == 1 and 'Scout found things.' in delivered[0]
    assert len(model.views()) == 3  # no extra continuation: nothing was left to wait for
    assert [p['text'] for p in _payloads(lines) if p['type'] == 'final_text'] == ['Final with the report.']
    assert parent.subagent_pending_reports == {} and not bus.ready()
    started = bus.of(bus.child('scout'))[0]
    assert started['background'] is True and started['status_id']


async def test_turn_waits_for_running_subagents_then_continues_with_their_reports(
    checkpoints, parent_session, bus, use_model
) -> None:
    sid, parent = parent_session
    child_gate = asyncio.Event()
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn('s1', 'scout', 'look around', background=True)]),
                    AIMessage(content='Started it.'),
                    AIMessage(content='Final with results.'),
                ],
                'scout': [(AIMessage(content='Scout found things.'), child_gate)],
            }
        )
    )
    lines: list[str] = []
    turn = _start_turn(sid, 'go', lines, apply_mode=False)
    await _wait_for(lambda: _pill(lines, 'wait_for_subagents'))
    [running] = _pill(lines, 'wait_for_subagents')
    assert running['state'] == 'running' and running['source'] == 'tool'
    assert running['id'].startswith('subagent-wait-') and running['detail'] == '1 sub-agent: scout'

    child_gate.set()
    await asyncio.wait_for(turn, timeout=10)

    assert [s['state'] for s in _pill(lines, 'wait_for_subagents')] == ['running', 'complete']
    view = model.views()[-1]
    assert 'Started it.' in _texts(view)[-2]
    assert REPORTS_ARRIVED_HEADER in _texts(view)[-1] and 'Scout found things.' in _texts(view)[-1]
    assert [p['text'] for p in _payloads(lines) if p['type'] == 'final_text'] == ['Final with results.']
    assert parent.subagent_pending_reports == {} and not bus.ready()
    assert lines[-1] == 'data: [DONE]\n\n'


async def test_stopping_the_turn_during_the_wait_leaves_subagents_running_then_results_ready_and_continue(
    checkpoints, parent_session, bus, use_model
) -> None:
    from clara_coder_backend.routes.chat import chat_abort
    from clara_coder_backend.session.schemas import AbortRequest

    sid, parent = parent_session
    child_gate = asyncio.Event()
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn('s1', 'scout', 'look around', background=True)]),
                    AIMessage(content='Started it.'),
                    AIMessage(content='Continued with the results.'),
                ],
                'scout': [(AIMessage(content='Scout found things.'), child_gate)],
            }
        )
    )
    lines: list[str] = []
    turn = _start_turn(sid, 'go', lines, apply_mode=False)
    await _wait_for(lambda: _pill(lines, 'wait_for_subagents'))

    # Stop on the parent id stops only the parent's turn.
    await chat_abort(AbortRequest(session_id=sid))
    await asyncio.wait_for(turn, timeout=10)
    assert [s['state'] for s in _pill(lines, 'wait_for_subagents')] == ['running', 'complete']
    assert bus.finished('scout') is None and parent.subagent_children
    assert not bus.ready()  # nothing to deliver yet

    # The sub-agent finishes with no parent turn live: Electron is told to continue.
    child_gate.set()
    await _wait_for(lambda: bus.ready())
    assert bus.ready() == [{'type': 'subagent_results_ready', 'parent_conversation_id': sid, 'names': ['scout']}]
    assert list(parent.subagent_pending_reports) == [bus.child('scout')]

    lines2 = await _run_turn(sid, '', apply_mode=False, umid='u2', continue_with_subagent_results=True)
    user_input = _texts(model.views()[-1])[-1]
    assert REPORTS_ARRIVED_HEADER in user_input and 'Scout found things.' in user_input
    assert 'Continue the task with these results.' in user_input
    assert parent.history[-2]['role'] == 'user' and REPORTS_ARRIVED_HEADER in parent.history[-2]['content']
    assert [p['text'] for p in _payloads(lines2) if p['type'] == 'final_text'] == ['Continued with the results.']
    assert parent.subagent_pending_reports == {} and len(bus.ready()) == 1


async def test_cancelled_foreground_spawn_detaches_the_child_and_the_next_turn_gets_its_report(
    checkpoints, parent_session, bus, use_model
) -> None:
    from clara_coder_backend.session.turns import _abort_session_turn

    sid, parent = parent_session
    child_gate = asyncio.Event()
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='Delegating.', tool_calls=[_spawn('s1', 'scout', 'look around')]),
                    AIMessage(content='Second turn answer.'),
                ],
                'scout': [(AIMessage(content='Scout found things.'), child_gate)],
            }
        )
    )
    lines: list[str] = []
    turn = _start_turn(sid, 'do it', lines, apply_mode=False)
    await _wait_for(lambda: 'Scout' in (bus.child_text('scout') if bus.started('scout') else ''))

    # A new message preempts the turn: only the parent's generation stops.
    await _abort_session_turn(sid)
    await asyncio.wait_for(turn, timeout=10)
    assert lines[-1] == 'data: [DONE]\n\n'
    assert parent.history[-1]['content'].endswith('[Interrupted by the user]')
    assert bus.finished('scout') is None
    note = parent.subagent_interrupted_reports['s1']
    assert note.startswith('Sub-agent `scout` is still running independently (this turn ended before it reported).')
    assert 'wait_for_subagents or stop_subagent' in note

    child_gate.set()
    await _wait_for(lambda: bus.finished('scout') == 'completed')
    assert bus.ready() and list(parent.subagent_pending_reports) == [bus.child('scout')]

    second = _payloads(await _run_turn(sid, 'next please', apply_mode=False, umid='u2'))
    assert [p['text'] for p in second if p['type'] == 'final_text'] == ['Second turn answer.']
    view = model.views()[-1]
    kinds = [(m.type, getattr(m, 'tool_call_id', None)) for m in view]
    ai_at = kinds.index(('ai', None))
    assert kinds[ai_at + 1] == ('tool', 's1') and 'still running independently' in str(view[ai_at + 1].content)
    texts = _texts(view)
    assert sum(REPORTS_ARRIVED_HEADER in t for t in texts) == 1
    report_at = next(i for i, t in enumerate(texts) if REPORTS_ARRIVED_HEADER in t)
    assert 'Scout found things.' in texts[report_at] and report_at == len(texts) - 2  # right before the user's message
    assert 'next please' in texts[-1]
    assert parent.subagent_pending_reports == {} and parent.subagent_interrupted_reports == {}


# ---------------------------------------------------------------------------
# wait_for_subagents / stop_subagent
# ---------------------------------------------------------------------------


async def test_wait_for_subagents_returns_their_reports(checkpoints, parent_session, bus, use_model) -> None:
    sid, parent = parent_session
    gate = asyncio.Event()
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(
                        content='',
                        tool_calls=[_spawn('s1', 'a', 'A', background=True), _spawn('s2', 'b', 'B', background=True)],
                    ),
                    AIMessage(content='', tool_calls=[_call('w1', 'wait_for_subagents', names=['a', 'b'])]),
                    AIMessage(content='Both in.'),
                ],
                'a': [(AIMessage(content='A result.'), gate)],
                'b': [(AIMessage(content='B result.'), gate)],
            }
        )
    )
    lines: list[str] = []
    turn = _start_turn(sid, 'go', lines, apply_mode=False)
    await _wait_for(lambda: any(s['state'] == 'running' for s in _pill(lines, 'wait_for_subagents')))
    gate.set()
    await asyncio.wait_for(turn, timeout=10)

    view = model.views()[-1]
    result = next(str(m.content) for m in view if m.type == 'tool' and m.tool_call_id == 'w1')
    assert 'A result.' in result and 'B result.' in result
    assert not any(REPORTS_ARRIVED_HEADER in t for t in _texts(view))  # delivered once, by the tool
    assert parent.subagent_pending_reports == {} and not bus.ready()


async def test_wait_for_subagents_tool_timeout_unknown_names_and_waiting_reports() -> None:
    from clara_coder_backend.session.state import current_session_id
    from clara_coder_backend.tools.subagent_control import wait_for_subagents_tool

    parent = state.get_session('wait-parent')
    run = _fake_run('wait-parent', parent, 'c-slow', 'slow')
    run.task = asyncio.get_running_loop().create_task(asyncio.sleep(30))
    parent.subagent_pending_reports['c-done'] = SubagentReport('c-done', 'done', 'Sub-agent `done` finished.', 'completed')
    token = current_session_id.set('wait-parent')
    try:
        out = await wait_for_subagents_tool.ainvoke({'names': ['slow', 'done', 'ghost'], 'timeout_seconds': 1})
        assert 'Sub-agent `done` finished.' in out
        assert 'Still running after 1s: `slow`' in out and 'No sub-agent named `ghost`' in out
        assert parent.subagent_pending_reports == {} and run.waiters == 0
        assert not run.task.done()  # waiting never stops it

        nothing = await wait_for_subagents_tool.ainvoke({'names': ['ghost']})
        assert 'No sub-agent named `ghost`' in nothing and '`slow`' in nothing
    finally:
        current_session_id.reset(token)
        run.task.cancel()
        state.sessions.pop('wait-parent', None)


async def test_stop_subagent_tool_stops_it_and_returns_its_partial_report(
    checkpoints, parent_session, bus, use_model
) -> None:
    sid, parent = parent_session
    gate = asyncio.Event()  # stop only once the sub-agent has produced some output
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn('s1', 'scout', 'look', background=True)]),
                    (AIMessage(content='Stopping.', tool_calls=[_call('x1', 'stop_subagent', name='scout')]), gate),
                    AIMessage(content='Stopped it.'),
                ],
                'scout': [(AIMessage(content='Scout partial words'), _HANG)],
            }
        )
    )
    lines: list[str] = []
    turn = _start_turn(sid, 'go', lines, apply_mode=False)
    await _wait_for(lambda: bus.started('scout') and 'Scout' in bus.child_text('scout'))
    gate.set()
    await asyncio.wait_for(turn, timeout=10)

    result = next(str(m.content) for m in model.views()[-1] if m.type == 'tool' and m.tool_call_id == 'x1')
    assert 'was stopped by the main agent before it finished' in result and 'Scout' in result
    assert bus.finished('scout') == 'aborted'
    assert parent.subagent_pending_reports == {} and not bus.ready()
    assert not any(REPORTS_ARRIVED_HEADER in t for t in _texts(model.views()[-1]))


async def test_stopping_one_subagent_from_its_card_gives_the_waiting_call_its_partial_report(
    checkpoints, parent_session, bus, use_model
) -> None:
    sid, _parent = parent_session
    model = use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='Delegating.', tool_calls=[_spawn('s1', 'alpha', 'look at A'), _spawn('s2', 'beta', 'look at B')]),
                    AIMessage(content='Parent final answer.'),
                ],
                'alpha': [(AIMessage(content='Alpha partial words'), _HANG)],
                'beta': [AIMessage(content='Beta report text.')],
            }
        )
    )
    lines: list[str] = []
    turn = _start_turn(sid, 'do it', lines, apply_mode=False)
    await _wait_for(lambda: bus.started('alpha') and 'Alpha' in bus.child_text('alpha') and bus.finished('beta'))

    await abort_subagent(bus.child('alpha'))  # ``/chat/abort`` with the child id
    await asyncio.wait_for(turn, timeout=10)

    assert bus.finished('alpha') == 'aborted' and bus.finished('beta') == 'completed'
    assert [p['text'] for p in _payloads(lines) if p['type'] == 'final_text'] == ['Parent final answer.']
    alpha_result = next(str(m.content) for m in model.views()[-1] if m.type == 'tool' and m.tool_call_id == 's1')
    assert 'stopped by the user' in alpha_result and 'Alpha' in alpha_result


async def test_child_approval_card_is_answered_with_the_child_id(checkpoints, parent_session, bus, use_model) -> None:
    from clara_coder_backend.routes.chat import agent_continue

    sid, parent = parent_session
    command = _call('c1', 'run_command', command='echo hi')
    use_model(
        ScriptedChatModel(
            scripts={
                'parent': [
                    AIMessage(content='', tool_calls=[_spawn('s1', 'runner', 'run echo')]),
                    AIMessage(content='All done.'),
                ],
                'runner': [AIMessage(content='', tool_calls=[command]), AIMessage(content='It was cancelled.')],
            }
        )
    )
    lines: list[str] = []
    turn = _start_turn(sid, 'run it', lines, apply_mode=True, auto_apply_mode=False)

    def card() -> dict[str, Any] | None:
        if not bus.started('runner'):
            return None
        return next(
            (
                e['payload']
                for e in bus.of(bus.child('runner'))
                if e['type'] == 'subagent_event' and e['payload']['type'] == 'accept_command'
            ),
            None,
        )

    await _wait_for(card)
    assert parent.pending_accept_command_request is None
    reply = await agent_continue(
        AgentContinueRequest(
            session_id=bus.child('runner'),
            accept_command_action='cancel',
            accept_command_request_id=card()['acceptCommand']['requestId'],
        )
    )
    assert reply['ok'] is True
    await asyncio.wait_for(turn, timeout=10)

    assert bus.finished('runner') == 'completed'
    assert [p['text'] for p in _payloads(lines) if p['type'] == 'final_text'] == ['All done.']


# ---------------------------------------------------------------------------
# Results ready, continue turns, routes
# ---------------------------------------------------------------------------


async def test_results_ready_only_when_no_parent_turn_is_live(bus) -> None:
    from clara_coder_backend.session.turns import TurnHandle, _turns_for

    parent = state.get_session('rr-parent')
    try:
        parent.subagent_pending_reports['c1'] = SubagentReport('c1', 'scout', 'r', 'completed')
        parent.subagent_live_turns = 1
        assert subagents.maybe_publish_results_ready('rr-parent') is False
        parent.subagent_live_turns = 0
        # A turn waiting to run takes them too.
        turns = _turns_for('rr-parent')
        handle = TurnHandle(session_id='rr-parent', seq=1)
        handle.task = asyncio.get_running_loop().create_task(asyncio.sleep(10))
        turns.pending.add(handle)
        assert subagents.maybe_publish_results_ready('rr-parent') is False
        handle.task.cancel()
        turns.pending.clear()
        assert subagents.maybe_publish_results_ready('rr-parent') is True
        assert bus.ready() == [{'type': 'subagent_results_ready', 'parent_conversation_id': 'rr-parent', 'names': ['scout']}]
    finally:
        state.sessions.pop('rr-parent', None)


async def test_continue_turn_builds_its_input_from_the_waiting_reports(monkeypatch, bus) -> None:
    from unittest.mock import AsyncMock, MagicMock

    sid = 'cont-parent'
    parent = state.get_session(sid)
    seen: list[Any] = []

    async def fake_stream(session: SessionState, *_args: Any, **kwargs: Any):
        seen.append(kwargs['user_message'])
        kwargs['outcome'].mark_completed(final_text='ok', partial_text='ok')
        yield 'data: {"type":"chunk","delta":"ok"}\n\n'

    monkeypatch.setattr('clara_coder_backend.composer.build_llm', MagicMock())
    monkeypatch.setattr('clara_coder_backend.composer.stream_single_agent_langgraph', fake_stream)
    monkeypatch.setattr('clara_coder_backend.composer.maybe_compact_outer_checkpoint', AsyncMock(return_value=None))
    try:
        parent.subagent_pending_reports['c1'] = SubagentReport('c1', 'scout', 'Sub-agent `scout` finished. X', 'completed')
        await _run_turn(sid, 'ignored', continue_with_subagent_results=True)
        assert seen[-1].startswith(REPORTS_ARRIVED_HEADER) and 'Sub-agent `scout` finished. X' in seen[-1]
        assert parent.history[-2] == {'role': 'user', 'content': seen[-1]}
        assert parent.subagent_pending_reports == {} and parent.subagent_live_turns == 0

        await _run_turn(sid, 'ignored', continue_with_subagent_results=True)
        assert seen[-1] == NO_NEW_REPORTS_TEXT
        assert not bus.ready()

        # A failed continue turn puts its reports back (and does not ask for another turn).
        async def failing(session: SessionState, *_args: Any, **kwargs: Any):
            kwargs['outcome'].mark_failed_runtime('boom')
            yield 'data: {"type":"chunk","delta":"x"}\n\n'

        monkeypatch.setattr('clara_coder_backend.composer.stream_single_agent_langgraph', failing)
        monkeypatch.setattr('clara_coder_backend.composer.delete_outer_thread', AsyncMock())
        parent.subagent_pending_reports['c2'] = SubagentReport('c2', 'b', 'B', 'completed')
        await _run_turn(sid, 'ignored', continue_with_subagent_results=True)
        assert list(parent.subagent_pending_reports) == ['c2'] and not bus.ready()
    finally:
        state.sessions.pop(sid, None)


async def test_chat_request_accepts_an_empty_continue_turn() -> None:
    from pydantic import ValidationError

    from clara_coder_backend.session.schemas import ChatRequest

    request = ChatRequest(session_id='p', message='', continue_with_subagent_results=True)
    assert request.continue_with_subagent_results is True
    with pytest.raises(ValidationError):
        ChatRequest(session_id='p', message='')


async def test_load_keeps_running_subagents_and_their_reports(bus, monkeypatch) -> None:
    from unittest.mock import AsyncMock

    from clara_coder_backend.routes.session import load_session
    from clara_coder_backend.session.schemas import LoadRequest

    monkeypatch.setattr('clara_coder_backend.routes.session.delete_outer_threads_for_session', AsyncMock())
    parent = state.get_session('load-parent')
    child = fork_subagent_session('load-parent', parent, 'load-child', 'scout')
    task = asyncio.get_running_loop().create_task(child.abort_event.wait())
    parent.subagent_children['load-child'] = task
    parent.subagent_pending_reports['c0'] = SubagentReport('c0', 'done', 'R', 'completed')
    parent.subagent_interrupted_reports['s1'] = 'stale'
    try:
        await load_session(LoadRequest(session_id='load-parent', messages=[{'role': 'user', 'message': 'hi'}]))
        await asyncio.sleep(0.01)
        assert not task.done() and not child.subagent_cancel_requested
        assert list(parent.subagent_pending_reports) == ['c0']
        assert parent.subagent_interrupted_reports == {}
        assert bus.ready() == [{'type': 'subagent_results_ready', 'parent_conversation_id': 'load-parent', 'names': ['done']}]
    finally:
        task.cancel()
        state.sessions.pop('load-child', None)
        state.sessions.pop('load-parent', None)


async def test_clear_stops_subagents_and_drops_their_reports(monkeypatch, bus) -> None:
    from unittest.mock import AsyncMock

    from clara_coder_backend.routes.session import clear_session
    from clara_coder_backend.session.schemas import ClearRequest

    monkeypatch.setattr('clara_coder_backend.routes.session.teardown_session', AsyncMock())
    parent = state.get_session('clr-parent')
    child = fork_subagent_session('clr-parent', parent, 'clr-child', 'scout')
    run = _fake_run('clr-parent', parent, 'clr-child', 'scout')
    run.child = child
    run.streaming = True

    async def child_turn() -> None:
        await child.abort_event.wait()

    run.task = asyncio.get_running_loop().create_task(child_turn())
    parent.subagent_children['clr-child'] = run.task
    parent.subagent_pending_reports['c0'] = SubagentReport('c0', 'done', 'R', 'completed')
    try:
        await asyncio.wait_for(clear_session(ClearRequest(session_id='clr-parent')), timeout=5)
        assert run.task.done() and run.discard_report and child.subagent_cancel_requested
        assert parent.subagent_pending_reports == {}
        assert state.sessions['clr-parent'] is not parent
        assert not bus.ready()
    finally:
        state.sessions.pop('clr-child', None)
        state.sessions.pop('clr-parent', None)


async def test_answer_sent_with_parent_id_reaches_the_waiting_child() -> None:
    from clara_coder_backend.routes.chat import _session_waiting_on

    parent = SessionState()
    try:
        child = fork_subagent_session('p-ans', parent, 'child-ans', 'x')
        parent.subagent_children['child-ans'] = asyncio.get_running_loop().create_future()  # type: ignore[assignment]
        child.pending_accept_command_request = {'request_id': 'req-9'}
        request = AgentContinueRequest(session_id='p-ans', accept_command_action='cancel', accept_command_request_id='req-9')
        assert _session_waiting_on(parent, request) is child
        other = AgentContinueRequest(session_id='p-ans', accept_command_action='cancel', accept_command_request_id='nope')
        assert _session_waiting_on(parent, other) is parent
    finally:
        state.sessions.pop('child-ans', None)


async def test_retired_subagent_ids_are_rejected_not_recreated() -> None:
    from fastapi import HTTPException

    from clara_coder_backend.routes.chat import agent_continue, chat_stream
    from clara_coder_backend.session.schemas import ChatRequest

    subagents.schedule_subagent_teardown('gone-child-1')
    await asyncio.sleep(0)
    assert is_subagent_session_id('gone-child-1')
    with pytest.raises(HTTPException) as exc:
        await chat_stream(ChatRequest(session_id='gone-child-1', message='hi'))
    assert exc.value.status_code == 400
    reply = await agent_continue(AgentContinueRequest(session_id='gone-child-1', accept_command_action='cancel'))
    assert reply['ok'] is False
    assert 'gone-child-1' not in state.sessions


# ---------------------------------------------------------------------------
# Shared resources
# ---------------------------------------------------------------------------


async def test_lsp_managers_of_a_subagent_are_keyed_by_its_parent(tmp_path) -> None:
    from clara_coder_backend.lsp.manager import _resolve_session_and_root, lsp_owner_session_id

    parent = state.get_session('lsp-parent')
    parent.workspace_path = str(tmp_path)
    try:
        fork_subagent_session('lsp-parent', parent, 'lsp-child', 'x')
        assert lsp_owner_session_id('lsp-child') == 'lsp-parent'
        assert lsp_owner_session_id('lsp-parent') == 'lsp-parent'
        sid, sess, root = _resolve_session_and_root('lsp-child')
        assert sid == 'lsp-parent' and sess is parent and root == tmp_path.resolve()
    finally:
        state.sessions.pop('lsp-child', None)
        state.sessions.pop('lsp-parent', None)


async def test_auto_apply_toggle_reaches_running_subagents() -> None:
    from clara_coder_backend.routes.session import session_auto_apply

    parent = state.get_session('aa-parent')
    try:
        child = fork_subagent_session('aa-parent', parent, 'aa-child', 'x')
        parent.subagent_children['aa-child'] = asyncio.get_running_loop().create_future()  # type: ignore[assignment]
        await session_auto_apply(SessionAutoApplyRequest(session_id='aa-parent', auto_apply_mode=True))
        assert parent.auto_apply_mode is True and child.auto_apply_mode is True
    finally:
        state.sessions.pop('aa-child', None)
        state.sessions.pop('aa-parent', None)


async def test_touched_paths_record_every_mutation_even_when_parent_journaled_first() -> None:
    from clara_coder_backend.session.file_journal import emit_edit_journal

    parent = SessionState()
    parent.current_user_message_id = 'turn-1'
    parent.hitl_sse_queue = asyncio.Queue()
    try:
        child = fork_subagent_session('tp-parent', parent, 'tp-child', 'x')
        child.hitl_sse_queue = asyncio.Queue()
        emit_edit_journal(parent, 'a.py', 'old', before_existed=True, encoding='utf-8', newline='lf')
        emit_edit_journal(child, 'a.py', 'old2', before_existed=True, encoding='utf-8', newline='lf')
        emit_edit_journal(child, 'b.py', '', before_existed=False, encoding='utf-8', newline='lf')

        assert child.subagent_touched_paths == {'a.py', 'b.py'}
        assert parent.hitl_sse_queue.qsize() == 1  # the family journals ``a.py`` once
        assert child.hitl_sse_queue.qsize() == 1  # only ``b.py`` from the child
    finally:
        state.sessions.pop('tp-child', None)


async def test_background_child_and_newer_parent_turn_do_not_rejournal_each_others_paths() -> None:
    """A background sub-agent journals under the turn that started it while the parent is on a newer one."""
    from clara_coder_backend.session.file_journal import emit_edit_journal

    parent = SessionState()
    parent.current_user_message_id = 'turn-1'
    parent.hitl_sse_queue = asyncio.Queue()
    try:
        child = fork_subagent_session('bj-parent', parent, 'bj-child', 'x')
        child.hitl_sse_queue = asyncio.Queue()
        emit_edit_journal(child, 'a.py', 'v0', before_existed=True, encoding='utf-8', newline='lf')
        parent.current_user_message_id = 'turn-2'
        emit_edit_journal(parent, 'b.py', 'v0', before_existed=True, encoding='utf-8', newline='lf')
        # Back and forth between the two turns: each path is journaled once per turn.
        emit_edit_journal(child, 'a.py', 'v1', before_existed=True, encoding='utf-8', newline='lf')
        emit_edit_journal(parent, 'b.py', 'v1', before_existed=True, encoding='utf-8', newline='lf')
        emit_edit_journal(parent, 'a.py', 'v2', before_existed=True, encoding='utf-8', newline='lf')

        child_rows = [child.hitl_sse_queue.get_nowait()[1] for _ in range(child.hitl_sse_queue.qsize())]
        parent_rows = [parent.hitl_sse_queue.get_nowait()[1] for _ in range(parent.hitl_sse_queue.qsize())]
        assert [(r['relativePath'], r['userMessageId']) for r in child_rows] == [('a.py', 'turn-1')]
        assert [(r['relativePath'], r['userMessageId']) for r in parent_rows] == [('b.py', 'turn-2'), ('a.py', 'turn-2')]
    finally:
        state.sessions.pop('bj-child', None)
