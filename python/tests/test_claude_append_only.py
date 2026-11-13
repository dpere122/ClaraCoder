"""A Claude thread only grows: what each request sends starts with everything the previous one sent.

Claude's preserved thinking binds each thinking block to the system prompt, the tools and every message before
it. These run ``graph.py``'s real graph and ``ClaraChatAnthropic`` against a fake Messages API (only the
transport is fake) and check the bodies on the wire, the way the API checks them: the system prompt and the
tool set unchanged, and every earlier message unchanged, thinking blocks included.
"""

from __future__ import annotations

import asyncio
import copy
import itertools
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx2
import pytest
import pytest_asyncio
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from clara_coder_backend.domain import (
    RuntimeConnection,
    RuntimeContextCompressionConfig,
    RuntimeToolsConfig,
    SessionState,
)
from clara_coder_backend.lang_agent import graph as graph_module
from clara_coder_backend.lang_agent.graph import build_clara_single_outer_graph
from clara_coder_backend.llm import anthropic_llm
from clara_coder_backend.llm.anthropic_llm import (
    COMPACTION_BETA,
    INLINE_TOOLS_BETA,
    SYSTEM_BLOCKS_KEY,
    build_anthropic_llm,
    place_system_messages,
    supports_mid_conversation_system,
)
from clara_coder_backend.llm.messages import USER_TURN_KEY
from clara_coder_backend.middleware.append_only_context_middleware import system_change_text
from clara_coder_backend.middleware.context_compaction_middleware import SERVER_COMPACTION_MIN_TRIGGER
from clara_coder_backend.session import checkpointing as ck
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.session.user_events import queue_user_event_note


_SID = 'claude-append-only'
_CAPS = {
    'enableThinking': False,
    'reasoningEffortValues': ['low', 'medium', 'high', 'xhigh', 'max'],
    'adaptiveThinking': True,
}


# ---------------------------------------------------------------------------
# The fake Messages API
# ---------------------------------------------------------------------------


def reply(*blocks: dict[str, Any], stop: str = 'end_turn') -> dict[str, Any]:
    return {'blocks': list(blocks), 'stop': stop}


def thinking(text: str = 'considering') -> dict[str, Any]:
    return {'type': 'thinking', 'thinking': text}


def text(body: str) -> dict[str, Any]:
    return {'type': 'text', 'text': body}


def tool_use(name: str, args: dict[str, Any], call_id: str) -> dict[str, Any]:
    return {'type': 'tool_use', 'id': call_id, 'name': name, 'input': args}


def compaction(summary: str, tool_changes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    block: dict[str, Any] = {'type': 'compaction', 'content': summary}
    if tool_changes is not None:
        block['tool_changes'] = tool_changes
    return block


class FakeClaude:
    """Scripted ``/v1/messages`` streams. Every thinking block gets a unique signature."""

    def __init__(self, script: list[dict[str, Any]]) -> None:
        self.script = list(script)
        self.bodies: list[dict[str, Any]] = []
        self.betas: list[list[str]] = []
        self._signatures = itertools.count(1)

    async def handler(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        self.bodies.append(body)
        self.betas.append([b.strip() for b in request.headers.get('anthropic-beta', '').split(',') if b.strip()])
        item = self.script.pop(0) if self.script else reply(thinking(), text('done'))
        return httpx2.Response(200, headers={'content-type': 'text/event-stream'}, content=self._sse(item))

    def _sse(self, item: dict[str, Any]) -> bytes:
        events: list[dict[str, Any]] = [
            {
                'type': 'message_start',
                'message': {
                    'id': 'msg_x',
                    'type': 'message',
                    'role': 'assistant',
                    'model': 'claude-opus-5-5',
                    'content': [],
                    'stop_reason': None,
                    'stop_sequence': None,
                    'usage': {'input_tokens': 100, 'output_tokens': 1},
                    'input_transformations': [],
                },
            }
        ]
        for index, block in enumerate(item['blocks']):
            kind = block['type']
            if kind == 'thinking':
                events.append({'type': 'content_block_start', 'index': index, 'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''}})
                events.append({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'thinking_delta', 'thinking': block['thinking']}})
                signature = f'sig-{next(self._signatures)}'
                events.append({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'signature_delta', 'signature': signature}})
            elif kind == 'text':
                events.append({'type': 'content_block_start', 'index': index, 'content_block': {'type': 'text', 'text': ''}})
                events.append({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'text_delta', 'text': block['text']}})
            elif kind == 'tool_use':
                events.append({'type': 'content_block_start', 'index': index, 'content_block': {'type': 'tool_use', 'id': block['id'], 'name': block['name'], 'input': {}}})
                events.append({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])}})
            elif kind == 'compaction':
                start = {'type': 'compaction', 'content': None, 'signature': f'csig-{index}'}
                if 'tool_changes' in block:
                    start['tool_changes'] = block['tool_changes']
                events.append({'type': 'content_block_start', 'index': index, 'content_block': start})
                events.append({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'compaction_delta', 'content': block['content']}})
            events.append({'type': 'content_block_stop', 'index': index})
        events.append({'type': 'message_delta', 'delta': {'stop_reason': item['stop'], 'stop_sequence': None}, 'usage': {'output_tokens': 7}})
        events.append({'type': 'message_stop'})
        return ''.join(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n' for event in events).encode()


# ---------------------------------------------------------------------------
# Tools, fixtures, helpers
# ---------------------------------------------------------------------------


@tool
def read_thing(path: str) -> str:
    """Read a thing."""
    return f'BODY of {path}'


@tool
def note_thing(note: str) -> str:
    """Queue a user event note for the next model call (a background command finishing does the same)."""
    queue_user_event_note(get_session(_SID), note)
    return 'queued'


@tool
def late_thing(query: str) -> str:
    """A tool that only some turns offer (an MCP server that connected later)."""
    return f'late {query}'


def tools_of(*tools: Any) -> Callable[..., Any]:
    def provider(apply_mode: bool, *, session: Any = None, include_subagent_tool: bool = False):
        del apply_mode, session, include_subagent_tool
        return list(tools), {t.name: t for t in tools}

    return provider


def _connection(*, server_compaction: bool = False, model: str = 'claude-opus-5-5') -> RuntimeConnection:
    caps = {**_CAPS, 'serverCompaction': server_compaction}
    return RuntimeConnection(
        id='claude',
        name='Claude',
        provider='anthropic',
        base_url='',
        model=model,
        api_key='test-claude-key',
        context_window_tokens=1_000_000,
        chat_template_reasoning=caps,
    )


@pytest_asyncio.fixture(loop_scope='function')
async def session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp.sqlite'))
    monkeypatch.setattr(runtime_config, 'connections', [_connection()])
    monkeypatch.setattr(runtime_config, 'active_connection_id', 'claude')
    monkeypatch.setattr(runtime_config, 'context_compression', RuntimeContextCompressionConfig())
    monkeypatch.setattr(runtime_config, 'tools', RuntimeToolsConfig())
    await ck.init_graph_checkpointing()
    sess = get_session(_SID)
    sess.workspace_path = ''
    sess.worker_apply_mode = True
    sess.hitl_sse_queue = asyncio.Queue()
    sess.planning_nested_events_q = asyncio.Queue()
    token = current_session_id.set(_SID)
    yield sess
    current_session_id.reset(token)
    await ck.shutdown_graph_checkpointing()


def use_server(monkeypatch: pytest.MonkeyPatch, server: FakeClaude) -> None:
    def clients(timeout: float) -> tuple[httpx2.Client, httpx2.AsyncClient]:
        del timeout
        return httpx2.Client(), httpx2.AsyncClient(transport=httpx2.MockTransport(server.handler))

    monkeypatch.setattr(anthropic_llm, 'acquire_anthropic_http_clients', clients)


def claude_graph(sess: SessionState, tools: Callable[..., Any]) -> Any:
    connection = runtime_config.connections[0]
    llm = build_anthropic_llm(connection, idle_timeout_sec=60)
    return build_clara_single_outer_graph(llm, sess, True, tools_provider=tools)


def user_turn(body: str) -> HumanMessage:
    return HumanMessage(content=body, additional_kwargs={USER_TURN_KEY: True})


async def run_turn(graph: Any, thread_id: str, *messages: Any) -> None:
    config = {'configurable': {'thread_id': thread_id}, 'recursion_limit': 200}
    async for _ in graph.astream_events({'messages': list(messages)}, config, version='v2', durability='sync'):
        pass


def _without_cache_markers(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _without_cache_markers(v) for k, v in value.items() if k != 'cache_control'}
    if isinstance(value, list):
        return [_without_cache_markers(v) for v in value]
    return value


def assert_append_only(bodies: list[dict[str, Any]]) -> None:
    """Each request keeps the previous one's system prompt, tools and messages, with what came back appended."""
    for earlier, later in itertools.pairwise(bodies):
        assert later['system'] == earlier['system']
        assert sorted(json.dumps(t, sort_keys=True) for t in later['tools']) == sorted(
            json.dumps(t, sort_keys=True) for t in earlier['tools']
        )
        old = _without_cache_markers(earlier['messages'])
        new = _without_cache_markers(later['messages'])
        if _opens_with_compaction(new):
            # Sent from the newest compaction block on: compare from that block (absent from ``old`` when this
            # request is the first to carry it, and then there is nothing before it to compare).
            if new[0] not in old:
                continue
            old = old[old.index(new[0]) :]
        assert new[: len(old)] == old
        assert new[len(old)]['role'] == 'assistant'


def _opens_with_compaction(messages: list[dict[str, Any]]) -> bool:
    first = messages[0]
    return first['role'] == 'assistant' and isinstance(first['content'], list) and first['content'][0].get('type') == 'compaction'


def thinking_signatures(body: dict[str, Any]) -> list[str]:
    return [
        block['signature']
        for message in body['messages']
        if message['role'] == 'assistant' and isinstance(message['content'], list)
        for block in message['content']
        if block.get('type') == 'thinking'
    ]


# ---------------------------------------------------------------------------
# Pure parts
# ---------------------------------------------------------------------------


def test_only_models_with_mid_conversation_system_messages_qualify() -> None:
    for model in ('claude-opus-5-5', 'claude-fable-5-2', 'claude-mythos-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8'):
        assert supports_mid_conversation_system(model), model
    for model in ('claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-7', ''):
        assert not supports_mid_conversation_system(model), model


def test_system_markers_go_out_before_the_next_assistant_turn() -> None:
    marker = {'type': '_clara_system_message', 'blocks': [{'type': 'text', 'text': 'update'}]}
    formatted = [
        {'role': 'user', 'content': [{'type': 'text', 'text': 'hi'}]},
        {'role': 'assistant', 'content': [{'type': 'text', 'text': 'calling'}]},
        {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 't', 'content': 'r'}, marker, {'type': 'text', 'text': 'note'}]},
        {'role': 'assistant', 'content': [{'type': 'text', 'text': 'ok'}]},
    ]
    placed = place_system_messages(copy.deepcopy(formatted))
    assert [m['role'] for m in placed] == ['user', 'assistant', 'user', 'system', 'assistant']
    assert placed[2]['content'] == [formatted[2]['content'][0], formatted[2]['content'][2]]
    assert placed[3]['content'] == [{'type': 'text', 'text': 'update'}]
    # A trailing notice ends the request.
    assert [m['role'] for m in place_system_messages(copy.deepcopy(formatted[:3]))] == ['user', 'assistant', 'user', 'system']


def test_system_change_text_names_new_and_gone_sections() -> None:
    update = system_change_text('Role.\n\nModel: A\n\nTree:\nold', 'Role.\n\nModel: B\n\nTree:\nnew')
    assert 'Model: B' in update and 'Tree:\nnew' in update
    assert '- Model: A' in update and '- Tree:' in update
    assert 'Role.' not in update.split('\n\n', 1)[1]


def test_compaction_blocks_go_back_without_the_stream_index() -> None:
    llm = build_anthropic_llm(_connection(), idle_timeout_sec=60)
    from langchain_core.messages import AIMessage

    history = [
        HumanMessage(content='hi'),
        AIMessage(content=[{'type': 'compaction', 'content': 'summary', 'index': 0}, {'type': 'text', 'text': 'ok', 'index': 1}]),
        HumanMessage(content='more'),
    ]
    payload = llm._get_request_payload(history, context_management={'edits': [{'type': 'compact_20260112'}]})
    # The request opens at the compaction block (the API drops what came before it) and sends it back clean.
    assert [m['role'] for m in payload['messages']] == ['assistant', 'user']
    assert payload['messages'][0]['content'][0] == {'type': 'compaction', 'content': 'summary'}
    assert COMPACTION_BETA in payload['betas']


# ---------------------------------------------------------------------------
# On the real graph
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope='function')
async def test_a_note_queued_mid_turn_stays_in_the_thread(monkeypatch: pytest.MonkeyPatch, session: SessionState) -> None:
    server = FakeClaude(
        [
            reply(thinking('a'), tool_use('note_thing', {'note': 'Background command finished: ok'}, 'toolu_1'), stop='tool_use'),
            reply(thinking('b'), tool_use('read_thing', {'path': 'x'}, 'toolu_2'), stop='tool_use'),
            reply(thinking('c'), text('all done')),
        ]
    )
    use_server(monkeypatch, server)
    graph = claude_graph(session, tools_of(read_thing, note_thing))
    await run_turn(graph, 't-note', user_turn('go'))

    assert len(server.bodies) == 3
    assert_append_only(server.bodies)
    for body in server.bodies[1:]:
        assert 'Background command finished: ok' in json.dumps(body['messages'])
    # Every earlier thinking block goes back as it came.
    assert thinking_signatures(server.bodies[2]) == ['sig-1', 'sig-2']


@pytest.mark.asyncio(loop_scope='function')
async def test_a_changed_system_prompt_is_appended_not_rerendered(monkeypatch: pytest.MonkeyPatch, session: SessionState) -> None:
    server = FakeClaude([reply(thinking('a'), text('first')), reply(thinking('b'), text('second')), reply(thinking('c'), text('third'))])
    use_server(monkeypatch, server)
    tools = tools_of(read_thing)
    await run_turn(claude_graph(session, tools), 't-sys', user_turn('one'))

    original = graph_module.build_system_prompt
    monkeypatch.setattr(graph_module, 'build_system_prompt', lambda s, a: original(s, a) + '\n\nWorkspace tree snapshot:\nnew-file.txt')
    # A new graph per turn, as after a restart: it renders the prompt again.
    await run_turn(claude_graph(session, tools), 't-sys', user_turn('two'))
    await run_turn(claude_graph(session, tools), 't-sys', user_turn('three'))

    assert_append_only(server.bodies)
    second = server.bodies[1]['messages']
    assert second[-1]['role'] == 'system'
    assert 'new-file.txt' in second[-1]['content'][0]['text']
    # Announced once: the third turn replays that message and adds none.
    third = server.bodies[2]['messages']
    assert sum(m['role'] == 'system' for m in third) == 1
    assert thinking_signatures(server.bodies[2]) == ['sig-1', 'sig-2']


@pytest.mark.asyncio(loop_scope='function')
async def test_tool_changes_are_announced_by_reference_and_by_value(monkeypatch: pytest.MonkeyPatch, session: SessionState) -> None:
    server = FakeClaude([reply(thinking('a'), text('first')), reply(thinking('b'), text('second')), reply(thinking('c'), text('third'))])
    use_server(monkeypatch, server)
    await run_turn(claude_graph(session, tools_of(read_thing, note_thing)), 't-tools', user_turn('one'))
    await run_turn(claude_graph(session, tools_of(read_thing, late_thing)), 't-tools', user_turn('two'))
    await run_turn(claude_graph(session, tools_of(read_thing, note_thing)), 't-tools', user_turn('three'))

    assert_append_only(server.bodies)
    assert {t['name'] for t in server.bodies[1]['tools']} == {'read_thing', 'note_thing'}
    second_notice = server.bodies[1]['messages'][-1]
    assert second_notice['role'] == 'system'
    kinds = [(b['type'], b['tool']['type']) for b in second_notice['content']]
    assert ('tool_addition', 'tool_definition') in kinds
    assert ('tool_removal', 'tool_reference') in kinds
    added = next(b for b in second_notice['content'] if b['type'] == 'tool_addition')
    assert added['tool']['definition']['name'] == 'late_thing'
    assert INLINE_TOOLS_BETA in server.betas[1]

    third_notice = server.bodies[2]['messages'][-1]
    assert {(b['type'], b['tool']['type'], b['tool'].get('name')) for b in third_notice['content']} == {
        ('tool_addition', 'tool_reference', 'note_thing'),
        ('tool_removal', 'tool_reference', 'late_thing'),
    }


@pytest.mark.asyncio(loop_scope='function')
async def test_server_compaction_replaces_client_compaction(monkeypatch: pytest.MonkeyPatch, session: SessionState) -> None:
    monkeypatch.setattr(runtime_config, 'connections', [_connection(server_compaction=True)])
    server = FakeClaude(
        [
            reply(thinking('a'), tool_use('read_thing', {'path': 'x'}, 'toolu_1'), stop='tool_use'),
            reply(compaction('<summary>read x</summary>'), stop='compaction'),
            reply(thinking('b'), tool_use('read_thing', {'path': 'y'}, 'toolu_2'), stop='tool_use'),
            reply(thinking('c'), text('done')),
        ]
    )
    use_server(monkeypatch, server)
    await run_turn(claude_graph(session, tools_of(read_thing)), 't-compact', user_turn('go'))

    assert len(server.bodies) == 4
    assert_append_only(server.bodies)
    for body, betas in zip(server.bodies, server.betas, strict=True):
        edit = body['context_management']['edits'][0]
        assert edit['type'] == 'compact_20260112'
        assert edit['trigger']['type'] == 'input_tokens'
        assert edit['trigger']['value'] >= SERVER_COMPACTION_MIN_TRIGGER
        assert COMPACTION_BETA in betas
        assert edit['pause_after_compaction'] is True
    # Paused after the block: the next request opens with it (the API drops what came before) and a note to go on.
    after_pause = server.bodies[2]['messages']
    assert [m['role'] for m in after_pause] == ['assistant', 'user']
    # Signature and all, as the start event carried it.
    assert after_pause[0]['content'] == [{'type': 'compaction', 'content': '<summary>read x</summary>', 'signature': 'csig-0'}]
    assert 'compacted' in json.dumps(after_pause[1]['content'])
    assert thinking_signatures(server.bodies[3]) == ['sig-2']


@pytest.mark.asyncio(loop_scope='function')
async def test_changes_are_announced_again_after_a_compaction(monkeypatch: pytest.MonkeyPatch, session: SessionState) -> None:
    monkeypatch.setattr(runtime_config, 'connections', [_connection(server_compaction=True)])
    server = FakeClaude(
        [
            reply(thinking('a'), text('first')),
            reply(thinking('b'), tool_use('late_thing', {'query': 'q'}, 'toolu_1'), stop='tool_use'),
            reply(compaction('<summary>so far</summary>'), stop='compaction'),
            reply(thinking('c'), tool_use('read_thing', {'path': 'y'}, 'toolu_2'), stop='tool_use'),
            reply(thinking('d'), text('done')),
        ]
    )
    use_server(monkeypatch, server)
    await run_turn(claude_graph(session, tools_of(read_thing)), 't-recompact', user_turn('one'))
    await run_turn(claude_graph(session, tools_of(read_thing, late_thing)), 't-recompact', user_turn('two'))

    assert_append_only(server.bodies)
    # Announced in the second request, then summarized away by the compaction (third response): the fourth
    # request opens with the compaction, the note to go on, and the addition again.
    assert server.bodies[1]['messages'][-1]['role'] == 'system'
    last = server.bodies[3]['messages']
    assert _opens_with_compaction(last)
    assert [m['role'] for m in last] == ['assistant', 'user', 'system']
    notices = [m for m in last if m['role'] == 'system']
    assert len(notices) == 1
    assert notices[0]['content'][0]['tool']['definition']['name'] == 'late_thing'


@pytest.mark.asyncio(loop_scope='function')
async def test_tool_changes_recorded_by_a_compaction_carry_over(monkeypatch: pytest.MonkeyPatch, session: SessionState) -> None:
    monkeypatch.setattr(runtime_config, 'connections', [_connection(server_compaction=True)])
    addition = {'type': 'tool_addition', 'tool': {'type': 'tool_definition', 'definition': {'name': 'late_thing'}}}
    server = FakeClaude(
        [
            reply(thinking('a'), text('first')),
            reply(compaction('<summary>so far</summary>', [addition]), stop='compaction'),
            reply(thinking('b'), tool_use('read_thing', {'path': 'y'}, 'toolu_1'), stop='tool_use'),
            reply(thinking('c'), text('done')),
        ]
    )
    use_server(monkeypatch, server)
    await run_turn(claude_graph(session, tools_of(read_thing)), 't-carry', user_turn('one'))
    await run_turn(claude_graph(session, tools_of(read_thing, late_thing)), 't-carry', user_turn('two'))

    assert_append_only(server.bodies)
    last = server.bodies[3]['messages']
    # The block goes back with its tool changes, which keep late_thing in effect: nothing is announced again.
    assert last[0]['content'][0]['tool_changes'] == [addition]
    assert all(m['role'] != 'system' for m in last)
    assert INLINE_TOOLS_BETA in server.betas[3]


@pytest.mark.asyncio(loop_scope='function')
async def test_other_claude_models_and_providers_are_left_alone(monkeypatch: pytest.MonkeyPatch, session: SessionState) -> None:
    monkeypatch.setattr(runtime_config, 'connections', [_connection(model='claude-sonnet-5')])
    server = FakeClaude([reply(thinking('a'), text('first')), reply(thinking('b'), text('second'))])
    use_server(monkeypatch, server)
    await run_turn(claude_graph(session, tools_of(read_thing)), 't-old', user_turn('one'))
    await run_turn(claude_graph(session, tools_of(read_thing, late_thing)), 't-old', user_turn('two'))

    assert {t['name'] for t in server.bodies[1]['tools']} == {'read_thing', 'late_thing'}
    assert all(m['role'] != 'system' for m in server.bodies[1]['messages'])
    assert 'context_management' not in server.bodies[0]


def test_notice_blocks_live_in_additional_kwargs() -> None:
    from clara_coder_backend.middleware.append_only_context_middleware import change_notice

    notice = change_notice('update', [{'type': 'tool_removal', 'tool': {'type': 'tool_reference', 'name': 'x'}}], [], ['x'])
    assert notice.additional_kwargs[SYSTEM_BLOCKS_KEY][0] == {'type': 'text', 'text': 'update'}
    assert 'Tools no longer available: x.' in notice.content
