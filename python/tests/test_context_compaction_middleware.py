"""Context compaction on the real chain: ``graph.py``'s graph, real ChatOpenAI, sqlite saver, SSE mapper.

Only the transport is fake: :class:`MockServer` answers ``/chat/completions`` over ``httpx.MockTransport`` the way
``llama-server`` does (full prompt in ``usage``, a 400 before any chunk when the prompt does not fit), so these
assert what goes on the wire and what the checkpoint keeps.
"""

from __future__ import annotations

import asyncio
import dataclasses
import itertools
import json
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import pytest_asyncio
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.types import Command

from clara_coder_backend.composer import stream_agent_reply
from clara_coder_backend.config import CLARA_SUBAGENT_MAX_CONCURRENCY
from clara_coder_backend.domain import (
    RuntimeConnection,
    RuntimeContextCompressionConfig,
    RuntimeToolsConfig,
    SessionState,
)
from clara_coder_backend.lang_agent import graph as graph_module
from clara_coder_backend.lang_agent.context_compaction import (
    BLOCK_HEADER,
    PIN_LEAD,
    SUMMARY_REQUEST,
    overflow_info,
    prompt_overhead_chars,
    thinking_budget_tokens,
)
from clara_coder_backend.lang_agent.graph import build_clara_single_outer_graph
from clara_coder_backend.lang_agent.langgraph_sse import GraphStreamState, sse_lines_for_graph_event
from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.lang_agent.subagent_bus import SUBAGENT_BUS
from clara_coder_backend.lang_agent.subagents import (
    REPORTS_ARRIVED_HEADER,
    SubagentReport,
    SubagentRun,
    fork_subagent_session,
    format_subagent_reports,
    parent_subagent_semaphore,
    start_subagent,
    stop_all_subagents,
)
from clara_coder_backend.llm import http_transport as ht
from clara_coder_backend.llm.messages import USER_TURN_KEY, build_system_prompt, compose_outer_turn_human_content
from clara_coder_backend.middleware import context_compaction_middleware as compaction_middleware
from clara_coder_backend.middleware.context_compaction_middleware import (
    COMPACT_PILL_LABEL,
    _EMPTY_REPLY_STOP_TEXT,
    _FUTILE_STOP_TEXT,
    _TRUNCATED_ANSWER_NOTE,
    _TRUNCATED_STOP_TEXT,
    ContextCompactionMiddleware,
    _capped_result,
)
from clara_coder_backend.plan import plan_execute as pe
from clara_coder_backend.plan.build_plan_store import _load_index
from clara_coder_backend.plan.plan_execute import ActionStep, BuildPlanModel, FileChangeEntry, render_build_plan_md
from clara_coder_backend.routes.chat import chat_abort
from clara_coder_backend.session import checkpointing as ck
from clara_coder_backend.session.schemas import AbortRequest
from clara_coder_backend.session.pause import stage_hitl_request
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.session.user_events import queue_user_event_note
from clara_coder_backend.tools.spawn_subagent import spawn_subagent_tool

pytestmark = pytest.mark.asyncio(loop_scope='function')

_MODEL_EXTRA_BODY = {'top_k': 40, 'min_p': 0.05, 'chat_template_kwargs': {'enable_thinking': True}}
_CHARS_PER_TOKEN = 4
_SID = 'cc-session'
#: Fields a notes call may differ in from the agent call before it, next to the one added message.
_NOTES_WIRE_DIFF = {
    'messages',
    'tool_choice',
    'max_tokens',
    'max_completion_tokens',
    'reasoning_budget_tokens',
    'reasoning_budget_message',
}


# ---------------------------------------------------------------------------
# The fake server
# ---------------------------------------------------------------------------


def _chunk(delta: dict | None = None, finish: str | None = None) -> dict:
    return {
        'choices': [{'finish_reason': finish, 'index': 0, 'delta': delta or {}}],
        'created': 1,
        'id': 'chatcmpl-x',
        'model': 'm',
        'object': 'chat.completion.chunk',
    }


def text_reply(text: str, *, finish: str = 'stop', reasoning: str = '', delay: float = 0.0) -> dict:
    deltas = [{'reasoning_content': reasoning}] if reasoning else []
    deltas += [{'content': text[i : i + 32]} for i in range(0, len(text), 32)]
    return {'deltas': deltas, 'finish': finish, 'delay': delay}


def calls_reply(*calls: tuple[str, dict | str, str], finish: str = 'tool_calls', completion_tokens: int = 5) -> dict:
    deltas: list[dict] = []
    for index, (name, args, call_id) in enumerate(calls):
        arguments = args if isinstance(args, str) else json.dumps(args)
        deltas.append(
            {
                'tool_calls': [
                    {'index': index, 'id': call_id, 'type': 'function', 'function': {'name': name, 'arguments': ''}}
                ]
            }
        )
        deltas.append({'tool_calls': [{'index': index, 'function': {'arguments': arguments}}]})
    return {'deltas': deltas, 'finish': finish, 'delay': 0.0, 'completion_tokens': completion_tokens}


def call_reply(name: str, args: dict | str, call_id: str = 'c1', *, finish: str = 'tool_calls') -> dict:
    return calls_reply((name, args, call_id), finish=finish)


def wire_chars(body: dict) -> int:
    """What the fake server counts as prompt: every message plus the tool schemas."""
    chars = len(json.dumps(body.get('tools') or []))
    for message in body['messages']:
        content = message.get('content')
        chars += len(content) if isinstance(content, str) else len(json.dumps(content or ''))
        chars += len(json.dumps(message['tool_calls'])) if message.get('tool_calls') else 0
    return chars


class _Stream(httpx.AsyncByteStream):
    """Streams chunks; ``aclose`` from another task makes the next read raise, like a closed socket."""

    def __init__(self, chunks: list[dict], delay: float, log: list[str]) -> None:
        self.chunks, self.delay, self.log = chunks, delay, log
        self.closed = asyncio.Event()

    async def __aiter__(self):
        for chunk in self.chunks:
            if self.delay:
                try:
                    await asyncio.wait_for(self.closed.wait(), self.delay)
                except asyncio.TimeoutError:
                    pass
            if self.closed.is_set():
                self.log.append('read-after-close')
                raise httpx.ReadError('peer closed connection (simulated)')
            yield f'data: {json.dumps(chunk)}\n\n'.encode()
        yield b'data: [DONE]\n\n'

    async def aclose(self) -> None:
        self.log.append('close')
        self.closed.set()


def overflow_response(n_prompt: int = 40000, n_ctx: int = 32768) -> httpx.Response:
    return httpx.Response(
        400,
        json={
            'error': {
                'code': 400,
                'message': f'request ({n_prompt} tokens) exceeds the available context size ({n_ctx} tokens), try increasing it',
                'type': 'exceed_context_size_error',
                'n_prompt_tokens': n_prompt,
                'n_ctx': n_ctx,
            }
        },
    )


class MockServer:
    """Scripted ``/v1/chat/completions``. A prompt over ``n_ctx`` gets ``llama-server``'s 400 instead of a reply.

    A script item is a reply, an ``httpx.Response``, or a function of the request body returning either. Notes
    calls take from ``summaries`` so a script can ignore when events fire.
    """

    def __init__(self, script: list[Any], *, n_ctx: int | None = None, summaries: list[Any] | None = None) -> None:
        self.script = list(script)
        self.summaries = list(summaries or [])
        self.requests: list[dict] = []
        self.stream_log: list[str] = []
        self.n_ctx = n_ctx
        self.overflows = 0
        self.on_request: Any = None
        self.last_answer: dict = text_reply('(script exhausted)')

    async def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        if self.on_request is not None:
            self.on_request(body)
        prompt = wire_chars(body) // _CHARS_PER_TOKEN
        if self.n_ctx is not None and prompt > self.n_ctx:
            self.overflows += 1
            return overflow_response(prompt, self.n_ctx)
        if is_summary_request(body):
            item = self.summaries.pop(0) if self.summaries else text_reply('NEXT STEP: go on.\nPROGRESS: some.')
        else:
            # An exhausted script repeats its last answer.
            item = self.script.pop(0) if self.script else self.last_answer
        if callable(item):
            item = item(body)
        if isinstance(item, dict) and not is_summary_request(body) and item['finish'] == 'stop':
            self.last_answer = item
        if isinstance(item, httpx.Response):
            if item.status_code == 400:
                self.overflows += 1
            return item
        chunks = [_chunk({'role': 'assistant', 'content': None})]
        chunks += [_chunk(delta) for delta in item['deltas']]
        chunks.append(_chunk(finish=item['finish']))
        completion = item.get('completion_tokens', 5)
        chunks.append(
            {
                'choices': [],
                'created': 1,
                'id': 'chatcmpl-x',
                'model': 'm',
                'object': 'chat.completion.chunk',
                'usage': {
                    'completion_tokens': completion,
                    'prompt_tokens': prompt,
                    'total_tokens': prompt + completion,
                },
                'timings': {'prompt_ms': 1.0, 'predicted_n': 5, 'predicted_per_second': 70.0},
            }
        )
        return httpx.Response(
            200,
            headers={'content-type': 'text/event-stream'},
            stream=_Stream(chunks, item['delay'], self.stream_log),
        )

    def agent_requests(self) -> list[dict]:
        return [body for body in self.requests if not is_summary_request(body)]

    def summary_requests(self) -> list[dict]:
        return [body for body in self.requests if is_summary_request(body)]


def is_summary_request(body: dict) -> bool:
    last = body['messages'][-1]
    return isinstance(last.get('content'), str) and last['content'].startswith('[Harness request.]')


def build_model(server: MockServer, **overrides: Any) -> ChatOpenAI:
    client = ht._OwnedAsyncClient(
        transport=httpx.MockTransport(server.handler),
        event_hooks={'request': [ht._on_async_request], 'response': [ht._on_async_response]},
    )
    kwargs: dict[str, Any] = {
        'model': 'm',
        'base_url': 'http://mock.invalid/v1',
        'api_key': 'dummy',
        'temperature': 0.65,
        'streaming': True,
        'stream_usage': True,
        'max_retries': 0,
        'http_async_client': client,
        'stream_chunk_timeout': 900.0,
        'top_p': 0.9,
        'reasoning_effort': 'medium',
        'extra_body': dict(_MODEL_EXTRA_BODY),
    }
    kwargs.update(overrides)
    return ChatOpenAI(**kwargs)


# ---------------------------------------------------------------------------
# Tools, fixtures, helpers
# ---------------------------------------------------------------------------


@tool('read_workspace_file')
def fake_read_file(relative_path: str, size: int = 400) -> str:
    """Read a file (a path never read before counts as progress)."""
    lines = max(1, size // 40)
    gutter = '\n'.join(f'{number:>4} │ {"x" * 32}' for number in range(1, lines + 1))
    return f'File: {relative_path}\nEncoding: utf-8\nLines: 1-{lines} (of 900 in file)\n\n{gutter}'


@tool
def read_thing(path: str, size: int = 40) -> str:
    """Read a thing (repeating a call with the same arguments is no progress in the digest's terms)."""
    return (f'BODY of {path} ' * (size // 8 + 1))[:size]


@tool
def pack_thing(pack: str) -> str:
    """Activate a context pack, as a matching tool call does: its text comes in front of the result."""
    get_session(_SID).activated_context_packs.add(pack)
    return f'---\nContext pack `{pack}` (activated):\nplaybook\n---\nresult'


@tool
def note_thing(note: str) -> str:
    """Queue a user event note for the next model call."""
    queue_user_event_note(get_session(_SID), note)
    return 'queued'


@tool('run_command')
def fake_command(command: str) -> str:
    """Stage an approval card, as a command does when Auto Run is off."""
    stage_hitl_request(get_session(_SID), 'pending_accept_command_request', {'request_id': command})
    return f'Pending user confirmation for `{command}`.'


_FAKE_TOOLS = [fake_read_file, read_thing, pack_thing, note_thing, fake_command]


def fake_tools(apply_mode: bool, *, session: Any = None, include_subagent_tool: bool = False):
    del apply_mode, session, include_subagent_tool
    return list(_FAKE_TOOLS), {t.name: t for t in _FAKE_TOOLS}


@tool('write_workspace_file')
def fake_write_file(relative_path: str, content: str) -> str:
    """Pretend to write a file."""
    return f'Created `{relative_path}` ({len(content)} chars).'


def _fake_tools_with_write(apply_mode: bool, *, session: Any = None, include_subagent_tool: bool = False):
    del apply_mode, session, include_subagent_tool
    tools = [*_FAKE_TOOLS, fake_write_file]
    return tools, {t.name: t for t in tools}


def _connection(window: int, provider: str = 'llamacpp') -> RuntimeConnection:
    return RuntimeConnection(
        id='p',
        name='p',
        provider=provider,
        base_url='http://mock.invalid/v1',
        model='m',
        context_window_tokens=window,
    )


def set_window(window: int, provider: str = 'llamacpp') -> None:
    runtime_config.connections[0] = _connection(window, provider)


@pytest_asyncio.fixture(loop_scope='function')
async def session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp.sqlite'))
    monkeypatch.setattr(runtime_config, 'connections', [_connection(0)])
    monkeypatch.setattr(runtime_config, 'active_connection_id', 'p')
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


def user_turn(text: str = 'do the work') -> HumanMessage:
    return HumanMessage(content=text, additional_kwargs={USER_TURN_KEY: True})


def fake_graph(server: MockServer, sess: SessionState, **kwargs: Any) -> Any:
    model = kwargs.pop('model', None) or build_model(server)
    return build_clara_single_outer_graph(model, sess, True, tools_provider=fake_tools, allow_subagents=True, **kwargs)


def thread(name: str = 't', limit: int = 400) -> dict:
    return {'configurable': {'thread_id': name}, 'recursion_limit': limit}


async def run_graph(
    graph: Any, config: dict, *messages: Any
) -> tuple[GraphStreamState, list[str], BaseException | None]:
    """One turn through the real SSE mapper: ``(mapper state, SSE lines, the exception if the graph raised)``."""
    state = GraphStreamState()
    lines: list[str] = []
    error: BaseException | None = None
    try:
        async for event in graph.astream_events({'messages': list(messages)}, config, version='v2', durability='sync'):
            lines.extend(
                sse_lines_for_graph_event(
                    event,
                    state,
                    agent_role=None,
                    status_label='Agent',
                    llm_event_prefix='step',
                    llm_log_context='test',
                    stream_tag='agent',
                )
            )
    except Exception as exc:  # noqa: BLE001
        error = exc
    return state, lines, error


async def private_state(graph: Any, config: dict) -> dict:
    return (await graph.aget_state(config)).values.get('context_compaction') or {}


async def thread_messages(graph: Any, config: dict) -> list[Any]:
    return (await graph.aget_state(config)).values['messages']


def overhead_tokens(sess: SessionState) -> int:
    """What the fake graph's system prompt and tools cost at the fake server's chars per token."""
    system = SystemMessage(content=build_system_prompt(sess, True))
    return prompt_overhead_chars(system, _FAKE_TOOLS) // _CHARS_PER_TOKEN


def small_window(sess: SessionState) -> int:
    """A window a few big reads fill, with room for overhead and an event's target."""
    return overhead_tokens(sess) * 2 + 8000


def read_script(rounds: int, size: int, *, final: str = 'all done', start: int = 0) -> list[dict]:
    """``rounds`` reads of never-read paths (so progress is made), then a final answer."""
    script = [
        call_reply('read_workspace_file', {'relative_path': f'p{i}.txt', 'size': size}, f'c{i}')
        for i in range(start, start + rounds)
    ]
    return [*script, text_reply(final)] if final else script


def assert_valid_view(body: dict) -> None:
    """A view a strict template accepts: opens with a user message, every tool result follows its call."""
    roles = [message['role'] for message in body['messages']]
    assert roles[0] == 'system'
    assert roles[1] == 'user'
    open_ids: set[str] = set()
    for message in body['messages'][1:]:
        if message['role'] == 'assistant':
            assert not open_ids, 'an assistant message came before the previous call results'
            open_ids = {call['id'] for call in message.get('tool_calls') or []}
        elif message['role'] == 'tool':
            assert message['tool_call_id'] in open_ids, 'orphan tool result'
            open_ids.discard(message['tool_call_id'])


def _without(body: dict, *fields: str) -> dict:
    return {key: value for key, value in body.items() if key not in fields}


def is_prefix(earlier: dict, later: dict) -> bool:
    return later['messages'][: len(earlier['messages'])] == earlier['messages'] and later.get('tools') == earlier.get(
        'tools'
    )


def first_with_block(bodies: list[dict]) -> dict:
    return next(
        body for body in bodies if BLOCK_HEADER in json.dumps(body['messages'][1]['content'], ensure_ascii=False)
    )


def block_of(body: dict) -> str:
    content = body['messages'][1]['content']
    assert isinstance(content, str)
    assert content.startswith(BLOCK_HEADER)
    return content


def drain(queue: asyncio.Queue) -> list[Any]:
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items


def compressed_events(sess: SessionState) -> list[dict]:
    return [item[1] for item in drain(sess.hitl_sse_queue) if item[0] == 'context_compressed']


def sse_payloads(lines: list[str]) -> list[dict]:
    return [json.loads(line[6:]) for line in lines if line.startswith('data: {')]


def sse_statuses(lines: list[str]) -> list[dict]:
    return [payload['status'] for payload in sse_payloads(lines) if payload.get('type') == 'status']


@contextmanager
def turns_on(server: MockServer, tools_provider: Callable[..., Any] = fake_tools) -> Iterator[None]:
    """Composer turns in this block run on ``server``'s model and the given tools."""
    llm = build_model(server)

    def builder(model: Any, sess: SessionState, mode: bool, extra: Any) -> Any:
        return build_clara_single_outer_graph(
            model, sess, mode, extra_middleware=extra, tools_provider=tools_provider, allow_subagents=True
        )

    with (
        patch('clara_coder_backend.composer.build_llm', return_value=llm),
        patch('clara_coder_backend.lang_agent.graph.build_llm', return_value=llm),
        patch('clara_coder_backend.lang_agent.graph._chat_outer_graph_builder', builder),
    ):
        yield


def composer_turn(
    server: MockServer, text: str, *, outcome: LangGraphWorkerOutcome | None = None, apply_mode: bool = True
):
    """The whole turn: composer, stream runner, event pump, on the fake tools."""

    async def run() -> list[str]:
        with turns_on(server):
            return [line async for line in stream_agent_reply(_SID, text, apply_mode=apply_mode, outcome_sink=outcome)]

    return run()


async def saved_thread() -> dict:
    """The channel values a composer turn left in the checkpoint."""
    config = {'configurable': {'thread_id': ck.outer_agent_thread_id(_SID, 'single', apply_mode=True)}}
    saved = await ck.get_graph_checkpointer().aget_tuple(config)
    assert saved is not None
    return saved.checkpoint['channel_values']


# ---------------------------------------------------------------------------
# The whole mechanism
# ---------------------------------------------------------------------------


async def test_long_loop_on_a_small_window_never_overflows(session: SessionState) -> None:
    """A loop far larger than the window, on a server that rejects whatever does not fit."""
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(40, 6000), n_ctx=window)
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert server.overflows == 0
    assert state.last_final_text == 'all done'
    events = compressed_events(session)
    assert events, 'the loop outgrew the window without one event'
    agent = server.agent_requests()
    assert len(agent) == 41
    # Every call a valid view; a call without an event is the previous step's prompt, byte for byte.
    breaks = 0
    gone: set[str] = set()
    for earlier, later in zip(agent, agent[1:]):
        assert_valid_view(later)
        breaks += not is_prefix(earlier, later)
        # What a cut removed stays removed: the tail only moves forward.
        in_view = {message['tool_call_id'] for message in later['messages'] if message['role'] == 'tool'}
        assert not gone & in_view
        gone |= {message['tool_call_id'] for message in earlier['messages'] if message['role'] == 'tool'} - in_view
    assert breaks == len(events)
    assert gone
    # The checkpoint keeps everything, untouched: compaction lives in the view.
    messages = await thread_messages(graph, thread())
    results = [m for m in messages if isinstance(m, ToolMessage)]
    assert len(results) == 40
    assert all(m.content.startswith('File: p') and BLOCK_HEADER not in m.content for m in results)
    assert messages[0].content == 'do the work'
    # The private state stays out of the graph's output and stays small.
    cc = await private_state(graph, thread())
    assert set(cc['elided_ids']) <= {m.id for m in messages}
    assert cc['cut_id'] in {m.id for m in messages}
    assert cc['floor_id'] in {m.id for m in messages}


async def test_no_event_calls_are_byte_identical_on_the_wire(session: SessionState) -> None:
    server = MockServer(read_script(4, 200))
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    agent = server.agent_requests()
    assert len(agent) == 5
    for earlier, later in zip(agent, agent[1:]):
        assert is_prefix(earlier, later)
        # Everything else stays too, except the thinking bound, which is not part of the prompt.
        assert _without(earlier, 'messages', 'reasoning_budget_tokens') == _without(
            later, 'messages', 'reasoning_budget_tokens'
        )
    assert 'tool_choice' not in agent[0] and agent[0]['max_tokens'] == 24576
    assert server.summary_requests() == []
    assert compressed_events(session) == []
    assert not await private_state(graph, thread())


async def test_after_an_event_the_view_is_byte_stable_until_the_next(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(16, 6000), n_ctx=window)
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    agent = server.agent_requests()
    blocks = [body['messages'][1]['content'] for body in agent if BLOCK_HEADER in str(body['messages'][1]['content'])]
    assert blocks
    # The same block repeats until an event replaces it: count changes against the events.
    changes = sum(a != b for a, b in zip(blocks, blocks[1:]))
    assert changes == len(compressed_events(session)) - 1


async def test_mid_turn_cut_opens_with_the_block_and_pins_the_request(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)
    request = compose_outer_turn_human_content(session, True, 'Fix the parser please.')

    await run_graph(graph, thread(), user_turn(request))

    body = first_with_block(server.agent_requests())
    assert_valid_view(body)
    block = block_of(body)
    assert 'FACTS:\n' in block
    assert 'Fix the parser please.' in block.split('FACTS:')[1].split('\n\n')[0]
    # The user's words, without the turn preamble.
    assert f'{PIN_LEAD}\nFix the parser please.' in block
    assert block.count('**Session truth') == 0
    assert body['messages'][2]['role'] == 'assistant'
    # The original message is not in the view any more, and not changed in the checkpoint.
    assert all(message.get('content') != request for message in body['messages'])
    messages = await thread_messages(graph, thread())
    assert messages[0].content == request


async def test_event_at_a_new_turn_merges_the_block_into_the_user_message(session: SessionState) -> None:
    """A plain chat history: the cut lands on a user turn, and the request stays in view, so nothing is pinned."""
    window = small_window(session)
    set_window(window)
    server = MockServer(
        [text_reply('x' * 16000), text_reply('y' * 16000), text_reply('z' * 16000), text_reply('answer')]
    )
    graph = fake_graph(server, session)

    for number in range(4):
        await run_graph(graph, thread(), user_turn(f'request {number}'))

    body = first_with_block(server.agent_requests())
    assert_valid_view(body)
    first = block_of(body)
    assert PIN_LEAD not in first
    assert re.search(r'\n\nrequest \d$', first)


async def test_old_untagged_checkpoint_works(session: SessionState) -> None:
    """A thread from before the tag: rows with no preamble, a turn with one. Nothing breaks, the request is pinned."""
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)
    preamble_turn = '**Session truth (authoritative for this message):**\n- Editor: **on**\n\nThe old request.'

    state, _lines, error = await run_graph(
        graph,
        thread(),
        HumanMessage(content='an old history row'),
        AIMessage(content='an old answer'),
        HumanMessage(content=preamble_turn),
    )

    assert error is None
    assert state.last_final_text == 'all done'
    body = first_with_block(server.agent_requests())
    assert_valid_view(body)
    assert f'{PIN_LEAD}\nThe old request.' in block_of(body)
    assert 'User requests, oldest first:\n- The old request.' in block_of(body)
    assert compressed_events(session)


async def test_the_tail_never_moves_back(session: SessionState) -> None:
    """Later small rounds and an elided body leave budget over: it must not bring back what a cut removed."""
    window = small_window(session)
    set_window(window)
    server = MockServer(
        [
            *read_script(6, 6000, final=''),
            *read_script(2, 200, final='', start=10),
            calls_reply(('read_thing', '{"path": "a', 'cut'), finish='length', completion_tokens=window),
        ]
    )
    graph = fake_graph(server, session)

    # The cut-off reply ends the turn and asks for an event on the next call.
    await run_graph(graph, thread(), user_turn())
    server.script = [text_reply('done')]
    state, _lines, error = await run_graph(graph, thread(), user_turn('go on'))

    assert error is None
    assert state.last_final_text == 'done'
    first = first_with_block(server.agent_requests())
    in_first_view = {message['tool_call_id'] for message in first['messages'] if message['role'] == 'tool'}
    in_last_view = {
        message['tool_call_id'] for message in server.agent_requests()[-1]['messages'] if message['role'] == 'tool'
    }
    assert in_first_view <= in_last_view
    assert in_last_view - in_first_view == {'c10', 'c11'}


async def test_crossing_round_keeps_its_call_with_a_placeholder(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    body = first_with_block(server.agent_requests())
    assert_valid_view(body)
    placeholders = [m for m in body['messages'] if str(m.get('content')).startswith('[Removed to save context: `p')]
    assert placeholders
    assert re.fullmatch(
        r'\[Removed to save context: `p\d+\.txt` lines 1-150 of 900\. Re-read only if needed now\.\]',
        placeholders[0]['content'],
    )
    # Bodies of the newest round are whole.
    assert body['messages'][-1]['content'].startswith('File: p')


async def test_block_carries_the_digest_of_the_whole_thread(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    session.prompt_tree_changes = [('created', 'new_file.py'), ('deleted', 'old_file.py')]
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn('Fix the parser.'))

    block = block_of(first_with_block(server.agent_requests()))
    assert 'User requests, oldest first:\n- Fix the parser.' in block
    # p0 left the view with the cut, and stays a fact.
    assert 'Files read: p0.txt' in block and 'p1.txt' in block
    assert '+ new_file.py, - old_file.py' in block


async def test_parallel_rounds_stay_whole_on_a_small_window(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    rounds = [
        calls_reply(
            ('read_workspace_file', {'relative_path': f'p{i}a.txt', 'size': 3000}, f'c{i}a'),
            ('read_workspace_file', {'relative_path': f'p{i}b.txt', 'size': 3000}, f'c{i}b'),
            ('read_workspace_file', {'relative_path': f'p{i}c.txt', 'size': 3000}, f'c{i}c'),
        )
        for i in range(20)
    ]
    server = MockServer([*rounds, text_reply('done')], n_ctx=window)
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    assert server.overflows == 0
    for body in server.agent_requests():
        assert_valid_view(body)
    assert compressed_events(session)


async def test_pin_ratio_bounds_the_pinned_request(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    request = 'q' * (window * 2)
    sizes = {}
    for ratio in (0.1, 0.25):
        server = MockServer(read_script(10, 6000))
        graph = fake_graph(server, session, compaction_pin_ratio=ratio)
        await run_graph(graph, thread(f'pin-{ratio}'), user_turn(request))
        block = block_of(first_with_block(server.agent_requests()))
        pin = block.split(PIN_LEAD)[1]
        assert 'chars removed for size' in pin
        sizes[ratio] = len(pin)
    limit = int(0.1 * window * 3.2)
    assert limit <= sizes[0.1] <= limit + 120
    assert sizes[0.25] > sizes[0.1] * 2


async def test_without_a_session_the_call_passes_through(session: SessionState) -> None:
    server = MockServer([text_reply('answer')])
    graph = fake_graph(server, session)
    token = current_session_id.set('')
    try:
        state, _lines, error = await run_graph(graph, thread(), user_turn())
    finally:
        current_session_id.reset(token)

    assert error is None
    assert state.last_final_text == 'answer'
    assert 'reasoning_budget_tokens' not in server.requests[0]


async def test_event_reaches_the_stream_through_the_runner(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))

    lines = await composer_turn(server, 'go')

    compressed = [payload for payload in sse_payloads(lines) if payload.get('type') == 'context_compressed']
    assert compressed
    assert compressed[0]['tokens_before'] > compressed[0]['tokens_after'] > 0
    pills = [status for status in sse_statuses(lines) if status['label'] == COMPACT_PILL_LABEL]
    assert [pill['state'] for pill in pills[:2]] == ['running', 'complete']
    assert pills[1]['duration_ms'] >= 0
    assert '\u2192' in pills[1]['detail']


# ---------------------------------------------------------------------------
# The notes call
# ---------------------------------------------------------------------------


async def test_notes_call_differs_on_the_wire_only_as_allowed(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    # Small rounds: when the soft trigger fires, the current view still has room for the notes.
    server = MockServer(read_script(30, 2000))
    graph = fake_graph(server, session, model=build_model(server, max_tokens=8192))

    await run_graph(graph, thread(), user_turn())

    summary = server.summary_requests()[0]
    position = server.requests.index(summary)
    before = server.requests[position - 1]
    assert not is_summary_request(before)
    assert _without(summary, *_NOTES_WIRE_DIFF) == _without(before, *_NOTES_WIRE_DIFF)
    assert summary['tool_choice'] == 'none'
    assert summary['max_tokens'] == 1500
    assert summary['max_completion_tokens'] == 1500
    assert summary['reasoning_budget_tokens'] == 0
    assert 'reasoning_budget_message' not in summary
    # The model's own extra body stays: its sampling and template kwargs are part of the prefix.
    for key, value in _MODEL_EXTRA_BODY.items():
        assert summary[key] == value
    # On the current view: the previous step's prompt, then its step, then the one request.
    assert summary['messages'][: len(before['messages'])] == before['messages']
    assert len(summary['messages']) == len(before['messages']) + 3
    assert summary['messages'][-1]['role'] == 'user'
    assert summary['messages'][-1]['content'].startswith(SUMMARY_REQUEST.split('{words}')[0])
    # The agent call right after has none of it.
    after = server.requests[position + 1]
    assert 'tool_choice' not in after
    assert after['max_completion_tokens'] == 8192
    assert after['reasoning_budget_tokens'] >= 512


async def test_summary_stays_out_of_sse_and_llm_step(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    notes = text_reply('NEXT STEP: secret-notes-text', reasoning='thoughts')
    server = MockServer(read_script(10, 6000), summaries=[notes, notes, notes])
    graph = fake_graph(server, session)

    with patch.object(compaction_middleware, 'log_llm_call_stats') as logged:
        state, lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert server.summary_requests()
    assert logged.call_count == len(server.summary_requests())
    assert logged.call_args.kwargs == {'context': 'context_compaction'}
    joined = ''.join(lines)
    assert 'secret-notes-text' not in joined
    assert state.llm_step == len(server.agent_requests())
    assert state.last_final_text == 'all done'
    # But the model has them, and the checkpoint's messages do not.
    assert 'NOTES:\nNEXT STEP: secret-notes-text' in block_of(first_with_block(server.agent_requests()))
    messages = await thread_messages(graph, thread())
    assert all('secret-notes-text' not in str(m.content) for m in messages)
    cc = await private_state(graph, thread())
    assert 'secret-notes-text' in cc['notes']


async def test_reasoning_excerpt_reaches_the_notes_call_only(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    long_reasoning = 'r' * 3000 + 'END-OF-THOUGHT'
    script = read_script(10, 6000)
    script[0] = {**script[0], 'deltas': [{'reasoning_content': long_reasoning}, *script[0]['deltas']]}
    server = MockServer(script)
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    prompt = server.summary_requests()[0]['messages'][-1]['content']
    assert prompt.endswith('END-OF-THOUGHT')
    assert 'r' * 1486 in prompt
    assert 'r' * 1487 not in prompt
    # Never echoed on the wire outside that excerpt.
    for body in server.agent_requests():
        assert 'END-OF-THOUGHT' not in json.dumps(body)
        assert all('reasoning_content' not in message for message in body['messages'])


async def test_template_refusing_the_notes_call_falls_through_to_the_agent_call(session: SessionState) -> None:
    """A template that rejects a Human after a tool result answers 500: digest only, and the turn goes on."""
    window = small_window(session)
    set_window(window)
    refusal = httpx.Response(
        500, json={'error': {'code': 500, 'message': 'Conversation roles must alternate', 'type': 'server_error'}}
    )
    server = MockServer(read_script(10, 6000), summaries=[refusal])
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'all done'
    block = block_of(first_with_block(server.agent_requests()))
    assert 'FACTS:\n' in block
    assert 'NOTES:' not in block
    position = server.requests.index(server.summary_requests()[0])
    assert not is_summary_request(server.requests[position + 1])


async def test_notes_call_that_overflows_falls_through_too(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000), summaries=[overflow_response(window + 1, window)])
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'all done'
    assert 'NOTES:' not in block_of(first_with_block(server.agent_requests()))


async def test_failed_notes_keep_the_earlier_ones(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(
        read_script(30, 6000),
        summaries=[
            text_reply('NEXT STEP: first-notes'),
            httpx.Response(500, json={'error': {'code': 500, 'message': 'x'}}),
        ],
    )
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    assert len(server.summary_requests()) >= 3
    # The events after the failed call still carry the notes from before it.
    position = server.requests.index(server.summary_requests()[1])
    later = next(body for body in server.requests[position + 1 :] if not is_summary_request(body))
    assert 'NOTES:\nNEXT STEP: first-notes' in block_of(later)


@pytest.mark.parametrize(
    'reply',
    [
        text_reply(''),
        text_reply('<tool_call><function=read_thing><parameter=path>a</parameter></function></tool_call>'),
    ],
)
async def test_unusable_notes_are_rejected(session: SessionState, reply: dict) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000), summaries=[reply])
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    assert server.summary_requests()
    assert 'NOTES:' not in block_of(first_with_block(server.agent_requests()))


_EMPTY_THOUGHT = '<|channel>thought\n<channel|>'


def _gemma_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(compaction_middleware, 'gemma_optimize_profile_active', lambda _c: True)


async def test_empty_gemma_notes_are_drawn_again(session: SessionState, monkeypatch: pytest.MonkeyPatch) -> None:
    """A thought and no notes is a sampling accident, as on the agent call, and the next try is three calls away."""
    _gemma_profile(monkeypatch)
    window = small_window(session)
    set_window(window)
    server = MockServer(
        read_script(10, 6000),
        summaries=[text_reply(_EMPTY_THOUGHT), text_reply(_EMPTY_THOUGHT * 3), text_reply('NEXT STEP: fresh-notes')],
    )
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    draws = server.summary_requests()[:3]
    assert draws[0]['messages'] == draws[1]['messages'] == draws[2]['messages']
    assert 'NOTES:\nNEXT STEP: fresh-notes' in block_of(first_with_block(server.agent_requests()))


async def test_notes_that_stay_empty_are_given_up_on_and_logged(
    session: SessionState, monkeypatch: pytest.MonkeyPatch
) -> None:
    _gemma_profile(monkeypatch)
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000), summaries=[text_reply(_EMPTY_THOUGHT) for _ in range(40)])
    graph = fake_graph(server, session)

    with patch.object(compaction_middleware.logger, 'warning') as warning:
        _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    positions = [index for index, body in enumerate(server.requests) if is_summary_request(body)]
    # One event's draws in a row, none of them on the agent's account.
    assert positions[:4] == list(range(positions[0], positions[0] + 4))
    assert 'NOTES:' not in block_of(first_with_block(server.agent_requests()))
    assert any('notes were unusable' in call.args[0] for call in warning.call_args_list)


async def test_unusable_notes_of_another_preset_are_not_drawn_again(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000), summaries=[text_reply('')])
    graph = fake_graph(server, session)

    with patch.object(compaction_middleware.logger, 'warning') as warning:
        await run_graph(graph, thread(), user_turn())

    positions = [index for index, body in enumerate(server.requests) if is_summary_request(body)]
    assert positions and not is_summary_request(server.requests[positions[0] + 1])
    assert any('notes were unusable' in call.args[0] for call in warning.call_args_list)


async def test_notes_at_most_every_three_model_calls(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    # Close trigger and target: nearly every step ends in an event.
    runtime_config.context_compression = RuntimeContextCompressionConfig(trigger_ratio=0.5, target_ratio=0.4)
    server = MockServer(read_script(24, 14000), n_ctx=window)
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    positions = [index for index, body in enumerate(server.requests) if is_summary_request(body)]
    events = compressed_events(session)
    assert len(events) > len(positions) >= 2
    calls_between = [
        sum(not is_summary_request(body) for body in server.requests[a:b]) for a, b in zip(positions, positions[1:])
    ]
    assert all(calls >= 3 for calls in calls_between)


async def test_tiny_window_compacts_without_notes(session: SessionState) -> None:
    """Below what a soft event plus a reserve needs there is no room for a notes call; the digest still works."""
    window = overhead_tokens(session) + 3000
    set_window(window)
    server = MockServer(read_script(8, 4000))
    graph = fake_graph(server, session)

    with patch.object(compaction_middleware.logger, 'warning') as warning:
        _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert compressed_events(session)
    assert server.summary_requests() == []
    assert sum('too small for compaction notes' in call.args[0] for call in warning.call_args_list) == 1
    assert 'FACTS:' in block_of(first_with_block(server.agent_requests()))


async def test_notes_use_the_cut_view_when_the_current_one_has_no_room(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    # Big rounds: the step that crosses the trigger leaves no room for the notes output on the current view.
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    summary = server.summary_requests()[0]
    position = server.requests.index(summary)
    assert_valid_view({**summary, 'messages': summary['messages'][:-1]})
    assert block_of(summary)
    # Without the notes yet, and with the prompt the agent call then sends, but for the block's notes.
    assert 'NOTES:' not in block_of(summary)
    after = server.requests[position + 1]
    assert summary['messages'][2:-1] == after['messages'][2:]
    assert wire_chars(summary) < window * _CHARS_PER_TOKEN


# ---------------------------------------------------------------------------
# Overflow
# ---------------------------------------------------------------------------


async def test_wrong_window_overflow_retries_with_the_servers_numbers(session: SessionState) -> None:
    """Settings say 200K, the server has much less: its n_ctx takes over, for this call and the next ones."""
    n_ctx = overhead_tokens(session) + 7000
    set_window(200_000)
    server = MockServer(read_script(10, 6000), n_ctx=n_ctx)
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'all done'
    assert server.overflows == 1
    cc = await private_state(graph, thread())
    assert cc['window'] == n_ctx
    # The rejected attempt shows as no step of its own.
    assert state.llm_step == len(server.agent_requests()) - server.overflows
    assert_valid_view(server.agent_requests()[-1])


async def test_overflow_retries_twice_then_succeeds(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    reads = read_script(6, 2000, final='')
    server = MockServer(
        [*reads, overflow_response(window + 5000, window), overflow_response(window + 100, window), text_reply('done')]
    )
    graph = fake_graph(server, session)

    state, lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    assert server.overflows == 2
    first, second, third = server.agent_requests()[len(reads) : len(reads) + 3]
    assert not is_prefix(first, second)
    # Each retry sends a smaller prompt, and each is a valid view.
    assert wire_chars(third) < wire_chars(second) < wire_chars(first)
    for body in (second, third):
        assert_valid_view(body)
    # Three starts in one step are one step for the UI.
    assert state.llm_step == len(reads) + 1
    assert not any(payload.get('type') == 'context_compressed' for payload in sse_payloads(lines))
    # Retries of one model call are one chance at progress, not several events without it.
    assert 'of tool output' not in str(third['messages'][1]['content'])
    assert (await private_state(graph, thread()))['futile'] == 0


async def test_third_overflow_raises(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    reads = read_script(6, 2000, final='')
    server = MockServer([*reads, *(overflow_response(window + 5000, window) for _ in range(5))])
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is not None
    assert overflow_info(error) == (window + 5000, window)
    assert server.overflows == 3


async def test_prompt_with_nothing_left_to_remove_raises_at_once(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer([overflow_response(window + 5000, window), text_reply('never')])
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn('short request'))

    assert error is not None
    assert server.overflows == 1
    assert len(server.requests) == 1


async def test_failed_turn_after_overflow_rebuilds_from_history(session: SessionState) -> None:
    """The third rejection is an ordinary failed turn: its thread goes, the next turn starts from the history."""
    server = MockServer(
        [text_reply('first answer'), *(overflow_response(90000, 32768) for _ in range(3))],
    )
    outcome = LangGraphWorkerOutcome()
    await composer_turn(server, 'turn one')

    lines = await composer_turn(server, 'turn two', outcome=outcome)

    assert outcome.state == AgentLoopOutcome.FAILED_RUNTIME
    assert any(status['state'] == 'error' for status in sse_statuses(lines))
    config = {'configurable': {'thread_id': ck.outer_agent_thread_id(_SID, 'single', apply_mode=True)}}
    assert await ck.get_graph_checkpointer().aget_tuple(config) is None

    server.script = [text_reply('third answer')]
    await composer_turn(server, 'turn three')

    rebuilt = server.requests[-1]['messages']
    assert [message['role'] for message in rebuilt] == ['system', 'user', 'assistant', 'user']
    assert rebuilt[2]['content'] == 'first answer'


@pytest.mark.parametrize(('calls', 'size_ratio'), [(1, 1.3), (3, 1.3), (6, 0.19)])
async def test_giant_tool_bodies_from_a_wrong_window_go_on_the_second_retry(
    session: SessionState, calls: int, size_ratio: float
) -> None:
    """Settings said 200K, so the tool cap let bodies in that overflow the real window, alone or together."""
    n_ctx = overhead_tokens(session) + 7000
    set_window(200_000)
    size = int(size_ratio * n_ctx * 3.2)
    batch = calls_reply(
        *(('read_workspace_file', {'relative_path': f'p{i}.txt', 'size': size}, f'c{i}') for i in range(calls))
    )
    server = MockServer([batch, text_reply('done')], n_ctx=n_ctx)
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    last = server.agent_requests()[-1]
    assert_valid_view(last)
    placeholders = [m for m in last['messages'] if str(m.get('content')).startswith('[Removed to save context: `p')]
    assert len(placeholders) == calls
    # Only in the view.
    messages = await thread_messages(graph, thread())
    assert next(m for m in messages if isinstance(m, ToolMessage)).content.startswith('File: p0.txt')


@pytest.mark.parametrize('earlier_turn', [False, True])
async def test_giant_request_is_capped_when_nothing_else_helps(session: SessionState, earlier_turn: bool) -> None:
    """It stays in the tail, as the current turn: only the overflow's last resort shortens it."""
    window = small_window(session)
    set_window(window)
    request = 'HEAD' + 'q' * (window * _CHARS_PER_TOKEN) + 'TAIL'
    server = MockServer([*read_script(2, 400)], n_ctx=window)
    graph = fake_graph(server, session)
    if earlier_turn:
        await run_graph(graph, thread(), user_turn('first'))
    server.script = [text_reply('done')]

    state, _lines, error = await run_graph(graph, thread(), user_turn(request))

    assert error is None
    assert state.last_final_text == 'done'
    assert server.overflows == 1
    content = server.agent_requests()[-1]['messages'][-1]['content']
    assert 'HEADqq' in content and content.endswith('TAIL')
    assert 'chars removed for size. Ask the user for a file if needed.]' in content
    assert len(content) < len(request) // 2
    messages = await thread_messages(graph, thread())
    assert request in [m.content for m in messages]
    # It stays that way: the next call keeps the prefix, and does not overflow again.
    last = server.agent_requests()[-1]
    server.script = [text_reply('next answer')]
    await run_graph(graph, thread(), user_turn('and now?'))
    assert is_prefix(last, server.agent_requests()[-1])
    assert server.overflows == 1


async def test_giant_write_args_go_on_the_second_retry_and_the_placeholder_is_refused(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    giant_write = call_reply(
        'write_workspace_file', {'relative_path': 'a.txt', 'content': 'w' * (window * _CHARS_PER_TOKEN)}, 'c-write'
    )
    seen: list[str] = []

    def copy_the_placeholder(body: dict) -> dict:
        call = next(message for message in body['messages'] if message.get('tool_calls'))
        content = json.loads(call['tool_calls'][0]['function']['arguments'])['content']
        seen.append(content)
        return call_reply('write_workspace_file', {'relative_path': 'a.txt', 'content': content}, 'c-copy')

    server = MockServer([giant_write, copy_the_placeholder, text_reply('done')], n_ctx=window)
    graph = build_clara_single_outer_graph(
        build_model(server), session, True, tools_provider=_fake_tools_with_write, allow_subagents=True
    )

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None, error
    assert state.last_final_text == 'done'
    assert server.overflows == 1
    assert seen[0].startswith('[Removed to save context: ')
    messages = await thread_messages(graph, thread())
    original = next(m for m in messages if isinstance(m, AIMessage) and m.tool_calls)
    assert original.tool_calls[0]['args']['content'].startswith('www')
    results = [m.content for m in messages if isinstance(m, ToolMessage)]
    assert 'placeholder' in results[-1]


async def test_overflow_without_numbers_narrows_the_window_to_the_estimate(session: SessionState) -> None:
    """The server only says it did not fit: it took less than what was sent, whatever Settings say."""
    set_window(200_000)
    hosted = httpx.Response(
        400,
        json={
            'error': {'message': 'Your input exceeds the context window of this model', 'type': 'invalid_request_error'}
        },
    )
    server = MockServer([*read_script(6, 2000, final=''), hosted, text_reply('done')])
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    assert server.overflows == 1
    agent = server.agent_requests()
    rejected = wire_chars(agent[6]) // _CHARS_PER_TOKEN
    cc = await private_state(graph, thread())
    assert 0.8 * rejected < cc['window'] < 1.5 * rejected
    assert cc['window_for'] == ['p', 'm', 200_000]
    assert wire_chars(agent[7]) < wire_chars(agent[6])


async def test_context_length_error_from_a_hosted_server_retries(session: SessionState) -> None:
    window = small_window(session)
    set_window(window, 'openai')
    hosted = httpx.Response(
        400,
        json={
            'error': {
                'message': f"This model's maximum context length is {window} tokens. However, your messages resulted in {window + 900} tokens.",
                'type': 'invalid_request_error',
                'code': 'context_length_exceeded',
            }
        },
    )
    server = MockServer([*read_script(6, 2000, final=''), hosted, text_reply('done')])
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    cc = await private_state(graph, thread())
    assert cc['window'] == window


async def _learn_a_window(sess: SessionState) -> tuple[MockServer, int]:
    """One overflow on a server with less than Settings say, through a whole turn: its ``n_ctx`` is the window now."""
    n_ctx = overhead_tokens(sess) + 7000
    set_window(200_000)
    server = MockServer(read_script(10, 6000), n_ctx=n_ctx)
    await composer_turn(server, 'turn one')
    assert server.overflows == 1
    assert (await saved_thread())['context_compaction']['window'] == n_ctx
    return server, n_ctx


@pytest.mark.parametrize(
    'change',
    [{'context_window_tokens': 400_000}, {'model': 'other-model'}, {'id': 'other-row'}],
    ids=['raised window', 'other model, same window', 'other connection, same window'],
)
async def test_a_learned_window_ends_when_what_it_was_learned_on_changes(session: SessionState, change: dict) -> None:
    """The thread outlives a raised ``-c`` and a model switch: its budget must follow, as the meter already does."""
    server, _n_ctx = await _learn_a_window(session)
    connection = dataclasses.replace(runtime_config.connections[0], **change)
    runtime_config.connections[0] = connection
    runtime_config.active_connection_id = connection.id
    server.n_ctx = None
    big = call_reply('read_workspace_file', {'relative_path': 'big.txt', 'size': 40000}, 'big')
    server.script = [big, text_reply('turn two done')]
    first = len(server.requests)

    lines = await composer_turn(server, 'turn two')

    assert not [payload for payload in sse_payloads(lines) if payload.get('type') == 'context_compressed']
    bodies = server.requests[first:]
    assert not [body for body in bodies if is_summary_request(body)]
    assert bodies[0]['reasoning_budget_tokens'] == 8192
    read = next(message for message in bodies[-1]['messages'] if message.get('tool_call_id') == 'big')
    assert '[Shortened to fit the context' not in read['content']


async def test_a_learned_window_holds_while_settings_stay_wrong(session: SessionState) -> None:
    """Across turns, so through the checkpoint: a tuple for a key would come back as a list and never match."""
    server, n_ctx = await _learn_a_window(session)
    overflows = server.overflows
    server.script = read_script(10, 6000, final='turn two done', start=50)

    await composer_turn(server, 'turn two')

    assert server.overflows == overflows
    cc = (await saved_thread())['context_compaction']
    assert cc['window'] == n_ctx
    assert cc['window_for'] == ['p', 'm', 200_000]


async def test_unrelated_model_error_is_not_retried(session: SessionState) -> None:
    server = MockServer(
        [
            httpx.Response(500, json={'error': {'code': 500, 'message': 'boom', 'type': 'server_error'}}),
            text_reply('never'),
        ]
    )
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is not None
    assert len(server.requests) == 1


# ---------------------------------------------------------------------------
# Truncated replies
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(loop_scope='function')
async def workspace(session: SessionState, tmp_path: Path):
    """The real read and edit tools on a real folder."""
    root = tmp_path / 'ws'
    root.mkdir()
    (root / 'notes.txt').write_text(''.join(f'line {n}\n' for n in range(1, 301)), encoding='utf-8')
    for number in range(30):
        (root / f'big{number}.txt').write_text(
            ''.join(f'{number} padding {n} {"z" * 60}\n' for n in range(1, 301)), encoding='utf-8'
        )
    session.workspace_path = str(root.resolve())
    session.current_user_message_id = 'turn-1'
    session.edits.journal_turn_id = ''
    session.edits.journaled_paths = set()
    session.edits.journal_earlier_turns = {}
    yield root


def real_graph(server: MockServer, sess: SessionState) -> Any:
    return build_clara_single_outer_graph(build_model(server), sess, True)


def real_overhead(sess: SessionState) -> int:
    from clara_coder_backend.hitl.tool_registry import worker_tools_and_map

    tools, _ = worker_tools_and_map(True, session=sess)
    return prompt_overhead_chars(SystemMessage(content=build_system_prompt(sess, True)), tools) // _CHARS_PER_TOKEN


async def test_truncated_write_never_executes_and_ends_the_turn(session: SessionState, workspace: Path) -> None:
    cut_off = call_reply('write_workspace_file', '{"relative_path": "new.txt", "content": "par', finish='length')
    server = MockServer([cut_off, text_reply('never asked for')])
    graph = real_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    # No second model call: the model is not told about the cut-off reply.
    assert len(server.requests) == 1
    assert session.harness_final_text == _TRUNCATED_STOP_TEXT
    assert not (workspace / 'new.txt').exists()
    snapshot = await graph.aget_state(thread())
    assert snapshot.next == ()
    messages = snapshot.values['messages']
    # Replaced in place, not appended, and nothing follows it.
    assert [type(m).__name__ for m in messages] == ['HumanMessage', 'AIMessage']
    assert messages[1].tool_calls == [] and messages[1].invalid_tool_calls == []
    assert messages[1].content == _TRUNCATED_STOP_TEXT
    assert not any(item[0] == 'agent_nudge' for item in drain(session.hitl_sse_queue))


async def test_empty_gemma_reply_is_drawn_again_without_touching_the_conversation(
    session: SessionState, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A thought and no answer, as when the channel-loop stop ends a reply, is a sampling accident: sample again."""
    monkeypatch.setattr(
        'clara_coder_backend.middleware.context_compaction_middleware.gemma_optimize_profile_active', lambda _c: True
    )
    server = MockServer([text_reply('<|channel>thought\n'), text_reply('<|channel>thought\n<channel|>the answer')])
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert len(server.requests) == 2
    assert server.requests[0]['messages'] == server.requests[1]['messages']
    messages = await thread_messages(graph, thread())
    assert [type(m).__name__ for m in messages] == ['HumanMessage', 'AIMessage']


async def test_empty_gemma_replies_that_keep_coming_stop_the_turn(
    session: SessionState, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        'clara_coder_backend.middleware.context_compaction_middleware.gemma_optimize_profile_active', lambda _c: True
    )
    server = MockServer([text_reply('<|channel>thought\n') for _ in range(12)])
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    # One model call: the first draw and its three silent redraws. No message about it reaches the model.
    assert len(server.requests) == 4
    assert all(body['messages'] == server.requests[0]['messages'] for body in server.requests)
    assert session.harness_final_text.startswith('Stopped: the model returned empty replies')


async def test_empty_reply_is_not_retried_for_other_presets_or_native_tool_calls(
    session: SessionState, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = MockServer([text_reply('')])
    await run_graph(fake_graph(server, session), thread('plain'), user_turn())
    assert len(server.requests) == 1
    assert not session.harness_final_text

    monkeypatch.setattr(
        'clara_coder_backend.middleware.context_compaction_middleware.gemma_optimize_profile_active', lambda _c: True
    )
    native = '<|channel>thought\n<channel|><|tool_call>call:read_thing{path:<|"|>a<|"|>}<tool_call|>'
    server = MockServer([text_reply(native), text_reply('done')])
    await run_graph(fake_graph(server, session), thread('native'), user_turn())
    # A native tool call is not an empty reply: no redraw, and no stop notice.
    assert len(server.requests) == 1
    assert not session.harness_final_text


async def test_a_new_request_starts_with_no_futile_events(session: SessionState) -> None:
    """Events of the last turn said nothing about this one: it must not be stopped for them."""
    window = small_window(session)
    set_window(window)
    reads = [call_reply('read_thing', {'path': 'same', 'size': 14000}, f'c{i}') for i in range(60)]
    server = MockServer([*reads[:9], text_reply('stopped reading')], n_ctx=window)
    graph = fake_graph(server, session)
    await run_graph(graph, thread(), user_turn())
    futile_before = (await private_state(graph, thread())).get('futile') or 0

    server.script = [text_reply('fresh answer')]
    state, _lines, _error = await run_graph(graph, thread(), user_turn('a new request'))

    assert state.last_final_text == 'fresh answer'
    assert not session.harness_final_text
    assert (await private_state(graph, thread())).get('futile') == 0 or futile_before == 0


async def test_truncated_xml_call_in_text_is_not_promoted(session: SessionState, workspace: Path) -> None:
    """Without the first after-model hook jumping, the pseudo-XML middleware would run this cut-off reply's call."""
    text = '<tool_call><function=write_workspace_file><parameter=relative_path>xml.txt</parameter><parameter=content>x</parameter></function></tool_call> and then'
    server = MockServer([text_reply(text, finish='length'), text_reply('never asked for')])
    graph = real_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert len(server.requests) == 1
    assert session.harness_final_text == _TRUNCATED_STOP_TEXT
    assert not (workspace / 'xml.txt').exists()


async def test_truncated_reply_ends_the_turn_with_visible_text(session: SessionState) -> None:
    server = MockServer([_cut_off_call('c1'), text_reply('never')])
    outcome = LangGraphWorkerOutcome()

    lines = await composer_turn(server, 'go', outcome=outcome)

    assert len(server.requests) == 1
    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == _TRUNCATED_STOP_TEXT
    assert any(
        payload.get('type') == 'final_text' and payload['text'] == outcome.final_text for payload in sse_payloads(lines)
    )
    # Not a failed turn: the thread stays and the history records what the user saw.
    config = {'configurable': {'thread_id': ck.outer_agent_thread_id(_SID, 'single', apply_mode=True)}}
    saved = await ck.get_graph_checkpointer().aget_tuple(config)
    assert saved is not None
    messages = saved.checkpoint['channel_values']['messages']
    assert not any(isinstance(m, ToolMessage) for m in messages)
    assert messages[-1].content == outcome.final_text and messages[-1].tool_calls == []
    assert session.history[-1]['content'] == outcome.final_text
    # The next turn carries nothing of it over.
    server.script = [text_reply('fine')]
    outcome = LangGraphWorkerOutcome()
    await composer_turn(server, 'again', outcome=outcome)
    assert outcome.final_text == 'fine'


async def test_cut_off_answer_keeps_its_text_with_a_note(session: SessionState) -> None:
    """A plain answer over the output cap: what came is the user's to continue from."""
    server = MockServer([text_reply('A long answer. It goes on and', finish='length'), text_reply('never')])
    outcome = LangGraphWorkerOutcome()

    await composer_turn(server, 'explain', outcome=outcome)

    assert len(server.requests) == 1
    assert outcome.state == AgentLoopOutcome.COMPLETED
    expected = f'A long answer. It goes on and\n\n{_TRUNCATED_ANSWER_NOTE}'
    assert outcome.final_text == expected
    assert session.history[-1]['content'] == expected
    assert (await saved_thread())['messages'][-1].content == expected
    # "Continue" has it on the wire.
    server.script = [text_reply('and then it ends.')]
    await composer_turn(server, 'continue')
    assert any(message.get('content') == expected for message in server.requests[-1]['messages'])


_CUT_OFF = {'finish_reason': 'length'}


@pytest.mark.parametrize(
    ('message', 'visible'),
    [
        (
            AIMessage(content='The parser has three stages. First', response_metadata=_CUT_OFF),
            'The parser has three stages. First',
        ),
        (
            AIMessage(
                content=[{'type': 'text', 'text': 'The parser has three stages.'}],
                response_metadata={'stop_reason': 'max_tokens'},
            ),
            'The parser has three stages.',
        ),
        (
            AIMessage(content='<|channel>thought\n<channel|>The test failed. Wait, why', response_metadata=_CUT_OFF),
            'The test failed. Wait, why',
        ),
    ],
    ids=['plain', 'content blocks', 'gemma prose'],
)
async def test_cut_off_plain_answer_keeps_only_its_visible_text(
    session: SessionState, message: AIMessage, visible: str
) -> None:
    update = await ContextCompactionMiddleware().aafter_model(
        {'messages': [user_turn(), message]}, None
    )

    assert update['jump_to'] == 'end'
    assert update['messages'][0].content == session.harness_final_text == f'{visible}\n\n{_TRUNCATED_ANSWER_NOTE}'


@pytest.mark.parametrize(
    'message',
    [
        AIMessage(content='<|channel>thought\nI should look at', response_metadata=_CUT_OFF),
        AIMessage(
            content='',
            additional_kwargs={'reasoning_content': 'thinking until the limit'},
            response_metadata=_CUT_OFF,
        ),
        AIMessage(
            content=(
                '<|channel>thought\n<channel|>Let me write it.<|tool_call>call:write_workspace_file'
                '{relative_path:<|"|>a.txt<|"|>,content:<|"|>partial'
            ),
            response_metadata=_CUT_OFF,
        ),
        AIMessage(
            content=(
                '<tool_call><function=write_workspace_file><parameter=relative_path>a.txt</parameter>'
                '<parameter=content>par'
            ),
            response_metadata=_CUT_OFF,
        ),
        AIMessage(
            content='Writing it now.\n<tool_call>{"name": "write_workspace_file", "arguments": {"content": "par',
            response_metadata=_CUT_OFF,
        ),
        AIMessage(
            content='Let me write.',
            tool_calls=[{'name': 'write_workspace_file', 'args': {'content': 'par'}, 'id': 'c', 'type': 'tool_call'}],
            response_metadata=_CUT_OFF,
        ),
    ],
    ids=['thought only', 'reasoning only', 'native call', 'xml call', 'hermes call', 'text and a structured call'],
)
async def test_cut_off_reply_with_no_plain_answer_keeps_the_stop_text(
    session: SessionState, message: AIMessage
) -> None:
    """Cut-off tool markup or reasoning as the answer would land in the checkpoint as if it had been said."""
    update = await ContextCompactionMiddleware().aafter_model(
        {'messages': [user_turn(), message]}, None
    )

    assert update['jump_to'] == 'end'
    assert update['messages'][0].content == session.harness_final_text == _TRUNCATED_STOP_TEXT
    assert update['messages'][0].tool_calls == []


async def test_truncated_thinking_is_discarded_like_any_reply(session: SessionState) -> None:
    server = MockServer([text_reply('', finish='length', reasoning='thinking until the limit'), text_reply('never')])
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert len(server.requests) == 1
    assert session.harness_final_text == _TRUNCATED_STOP_TEXT
    assert (await thread_messages(graph, thread()))[-1].content == _TRUNCATED_STOP_TEXT


async def test_truncated_near_the_window_forces_compaction_on_the_next_call(session: SessionState) -> None:
    """The prompt is small, the reply used up the context: without more room, going on would end the same way."""
    window = small_window(session)
    set_window(window)
    server = MockServer(
        [
            *read_script(4, 6000, final=''),
            calls_reply(('read_thing', '{"path": "a', 'cut'), finish='length', completion_tokens=window),
        ]
    )
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    assert session.harness_final_text == _TRUNCATED_STOP_TEXT
    assert (await private_state(graph, thread())).get('force') is True

    server.script = [text_reply('done')]
    state, _lines, error = await run_graph(graph, thread(), user_turn('go on'))

    assert error is None
    assert state.last_final_text == 'done'
    last = server.agent_requests()[-1]
    assert BLOCK_HEADER in last['messages'][1]['content']
    assert 'force' not in await private_state(graph, thread())
    assert compressed_events(session)


async def test_truncated_far_from_the_window_does_not_force(session: SessionState) -> None:
    set_window(400_000)
    server = MockServer([call_reply('read_thing', '{"path": "a', 'cut', finish='length'), text_reply('done')])
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    assert compressed_events(session) == []
    assert 'force' not in await private_state(graph, thread())


# ---------------------------------------------------------------------------
# The stale edit guard
# ---------------------------------------------------------------------------


def _cut_off_call(call_id: str) -> dict:
    return call_reply('read_thing', '{"path": "a', call_id, finish='length')


def _fill_with_reads(count: int, start: int = 0) -> list[dict]:
    return [
        call_reply('read_workspace_file', {'relative_path': f'big{i}.txt'}, f'fill{i}')
        for i in range(start, start + count)
    ]


def _edit_results(messages: list[Any], name: str) -> list[str]:
    calls = {call['id']: call for m in messages if isinstance(m, AIMessage) for call in m.tool_calls}
    return [m.content for m in messages if isinstance(m, ToolMessage) and calls[m.tool_call_id]['name'] == name]


async def test_guard_refuses_after_cut_and_allows_after_read(session: SessionState, workspace: Path) -> None:
    window = real_overhead(session) + 9000
    set_window(window)

    def replace(text: str, call_id: str, start: int = 40, end: int = 60) -> dict:
        args = {'relative_path': 'notes.txt', 'start_line': start, 'end_line': end, 'new_content': text}
        return call_reply('replace_workspace_lines', args, call_id)

    read_range = {'relative_path': 'notes.txt', 'start_line': 40, 'end_line': 60}
    server = MockServer(
        [
            call_reply('read_workspace_file', read_range, 'first-read'),
            *_fill_with_reads(12),
            replace('REFUSED', 'e1'),
            call_reply('read_workspace_file', read_range, 'second-read'),
            replace('ALLOWED', 'e2'),
            # Adjoining the read range: allowed, as appending at n+1 after reading up to n must be.
            replace('NEXT', 'e3', 42, 42),
            text_reply('done'),
        ]
    )
    graph = real_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    messages = await thread_messages(graph, thread())
    results = _edit_results(messages, 'replace_workspace_lines')
    assert results[0].startswith(
        'Tool error: `notes.txt` lines 40-60 are not in your context. Nothing was written. '
        'Read them with read_workspace_file, then retry.'
    )
    assert results[1].startswith('Updated `notes.txt`')
    assert results[2].startswith('Updated `notes.txt`')
    text = (workspace / 'notes.txt').read_text(encoding='utf-8')
    assert 'REFUSED' not in text
    assert 'ALLOWED' in text


async def test_guard_on_whole_file_writes(session: SessionState, workspace: Path) -> None:
    window = real_overhead(session) + 9000
    set_window(window)
    server = MockServer(
        [
            call_reply('read_workspace_file', {'relative_path': 'notes.txt'}, 'first-read'),
            *_fill_with_reads(12),
            # Overwriting what it no longer has: refused. A new file loses nothing: allowed.
            call_reply('write_workspace_file', {'relative_path': 'notes.txt', 'content': 'OVERWRITTEN'}, 'w1'),
            call_reply('write_workspace_file', {'relative_path': 'fresh.txt', 'content': 'one\ntwo\n'}, 'w2'),
            # A write in view: it knows the whole text, no read needed.
            call_reply(
                'replace_workspace_lines',
                {'relative_path': 'fresh.txt', 'start_line': 1, 'end_line': 1, 'new_content': 'ONE'},
                'w3',
            ),
            # A placeholder is not content, whatever the path.
            call_reply(
                'write_workspace_file',
                {
                    'relative_path': 'other.txt',
                    'content': '[Removed to save context: 900 chars. This call already ran; read the file to see them.]',
                },
                'w4',
            ),
            text_reply('done'),
        ]
    )
    graph = real_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    messages = await thread_messages(graph, thread())
    results = _edit_results(messages, 'write_workspace_file')
    assert results[0].startswith('Tool error: `notes.txt` is not in your context. Nothing was written.')
    assert results[1].startswith('Created `fresh.txt`')
    assert 'placeholder' in results[2]
    assert 'OVERWRITTEN' not in (workspace / 'notes.txt').read_text(encoding='utf-8')
    assert not (workspace / 'other.txt').exists()
    assert (workspace / 'fresh.txt').read_text(encoding='utf-8').startswith('ONE')
    assert _edit_results(messages, 'replace_workspace_lines')[0].startswith('Updated `fresh.txt`')


async def test_guard_takes_absolute_paths_like_the_tools_do(session: SessionState, workspace: Path) -> None:
    window = real_overhead(session) + 9000
    set_window(window)
    absolute = str((workspace / 'notes.txt').resolve())
    edit = {'relative_path': absolute, 'start_line': 40, 'end_line': 60, 'new_content': 'REFUSED'}
    read = {'relative_path': absolute, 'start_line': 40, 'end_line': 60}
    server = MockServer(
        [
            *_fill_with_reads(12),
            call_reply('replace_workspace_lines', edit, 'e1'),
            call_reply('read_workspace_file', read, 'r1'),
            call_reply('replace_workspace_lines', {**edit, 'new_content': 'ALLOWED'}, 'e2'),
            text_reply('done'),
        ]
    )
    graph = real_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    results = _edit_results(await thread_messages(graph, thread()), 'replace_workspace_lines')
    assert results[0].startswith('Tool error: `notes.txt` lines 40-60 are not in your context.')
    assert results[1].startswith('Updated `notes.txt`')
    text = (workspace / 'notes.txt').read_text(encoding='utf-8')
    assert 'REFUSED' not in text and 'ALLOWED' in text


async def test_guard_refuses_an_edit_batched_with_its_read(session: SessionState, workspace: Path) -> None:
    """The read's result is not in the model's view when the edit runs: same step, so it retries on the next."""
    window = real_overhead(session) + 9000
    set_window(window)
    read = ('read_workspace_file', {'relative_path': 'notes.txt', 'start_line': 40, 'end_line': 60}, 'read')
    edit = (
        'replace_workspace_lines',
        {'relative_path': 'notes.txt', 'start_line': 40, 'end_line': 60, 'new_content': 'E'},
        'edit',
    )
    retry = call_reply(edit[0], {**edit[1], 'new_content': 'RETRIED'}, 'retry')
    server = MockServer([*_fill_with_reads(12), calls_reply(read, edit), retry, text_reply('done')])
    graph = real_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    results = _edit_results(await thread_messages(graph, thread()), 'replace_workspace_lines')
    assert results[0].startswith('Tool error: `notes.txt` lines 40-60 are not in your context.')
    assert results[1].startswith('Updated `notes.txt`')
    assert 'RETRIED' in (workspace / 'notes.txt').read_text(encoding='utf-8')


async def test_guard_is_quiet_before_any_cut(session: SessionState, workspace: Path) -> None:
    server = MockServer(
        [
            call_reply(
                'replace_workspace_lines',
                {'relative_path': 'notes.txt', 'start_line': 1, 'end_line': 1, 'new_content': 'EDITED'},
                'e1',
            ),
            text_reply('done'),
        ]
    )
    graph = real_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    assert (workspace / 'notes.txt').read_text(encoding='utf-8').startswith('EDITED')


async def test_guard_lets_an_empty_file_be_filled_after_a_cut(session: SessionState, workspace: Path) -> None:
    """An empty file has no text to lose, and a read of it shows no line that could clear a refusal."""
    window = real_overhead(session) + 9000
    set_window(window)
    (workspace / 'first.py').write_text('', encoding='utf-8')
    (workspace / 'second.py').write_text('', encoding='utf-8')
    edit = {'relative_path': 'second.py', 'start_line': 1, 'end_line': 1, 'new_content': 'SEEDED'}
    server = MockServer(
        [
            *_fill_with_reads(12),
            call_reply('write_workspace_file', {'relative_path': 'first.py', 'content': 'WRITTEN'}, 'w1'),
            # A line edit has no such pass: it needs the read, and then the read must count.
            call_reply('replace_workspace_lines', edit, 'e1'),
            call_reply('read_workspace_file', {'relative_path': 'second.py'}, 'r1'),
            call_reply('replace_workspace_lines', edit, 'e2'),
            text_reply('done'),
        ]
    )
    graph = real_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    messages = await thread_messages(graph, thread())
    assert (await private_state(graph, thread()))['cut_id']
    assert _edit_results(messages, 'write_workspace_file')[0].startswith('Updated `first.py`')
    assert 'WRITTEN' in (workspace / 'first.py').read_text(encoding='utf-8')
    results = _edit_results(messages, 'replace_workspace_lines')
    assert results[0].startswith('Tool error: `second.py` lines 1-1 are not in your context.')
    assert results[1].startswith('Updated `second.py`')
    assert 'SEEDED' in (workspace / 'second.py').read_text(encoding='utf-8')


@pytest.mark.parametrize(
    'bad_args',
    [
        {'relative_path': 'notes.txt', 'start_line': [1]},
        {'relative_path': 'notes.txt', 'start_line': {'from': 1}},
        {'relative_path': 'notes.txt', 'end_line': [1, 50]},
    ],
    ids=['list start', 'dict start', 'list end'],
)
async def test_a_read_with_a_line_argument_that_cannot_be_hashed_costs_one_tool_error(
    session: SessionState, workspace: Path, bad_args: dict
) -> None:
    """It used to crash the next event, however many steps later, which failed the turn and deleted the thread."""
    set_window(real_overhead(session) + 9000)
    bad = call_reply('read_workspace_file', bad_args, 'bad')
    server = MockServer([bad, *_fill_with_reads(14), text_reply('done')])
    graph = real_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    messages = await thread_messages(graph, thread())
    result = next(m for m in messages if isinstance(m, ToolMessage) and m.tool_call_id == 'bad')
    assert result.status == 'error'
    block = (await private_state(graph, thread()))['block']
    assert 'big0.txt' in block
    assert 'notes.txt' not in block


async def test_a_refused_read_that_activates_a_context_pack_is_still_a_failed_read(
    session: SessionState, workspace: Path
) -> None:
    """The first read of a ``.pdf`` gets the pack's text in front of its result, which must stay a failed result."""
    set_window(real_overhead(session) + 9000)
    bad = call_reply('read_workspace_file', {'relative_path': 'paper.pdf', 'start_line': [1]}, 'bad')
    server = MockServer([bad, *_fill_with_reads(14), text_reply('done')])
    graph = real_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    messages = await thread_messages(graph, thread())
    result = next(m for m in messages if isinstance(m, ToolMessage) and m.tool_call_id == 'bad')
    assert 'Context pack `pdf` (activated):' in str(result.content)
    assert result.status == 'error'
    block = (await private_state(graph, thread()))['block']
    assert 'big0.txt' in block
    assert 'paper.pdf' not in block


async def test_edits_the_tool_node_refused_are_not_listed_and_are_no_progress(
    session: SessionState, workspace: Path
) -> None:
    """Nothing was written, and the status is what says so. A loop of them must meet the futile stop."""
    set_window(real_overhead(session) + 9000)
    no_content = [
        call_reply('write_workspace_file', {'relative_path': 'missing.py', 'text': 'x' * 6000}, f'w{number}')
        for number in range(80)
    ]
    server = MockServer([*no_content, text_reply('never')])
    graph = real_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    assert session.harness_final_text == _FUTILE_STOP_TEXT
    assert server.script, 'the loop ran to its end'
    assert not (workspace / 'missing.py').exists()
    assert 'missing.py' not in (await private_state(graph, thread()))['block']


async def test_guard_refuses_a_blind_edit_when_the_only_write_in_view_failed(
    session: SessionState, workspace: Path
) -> None:
    window = real_overhead(session) + 9000
    set_window(window)
    blind = {'relative_path': 'notes.txt', 'start_line': 200, 'end_line': 210, 'new_content': 'BLIND'}
    server = MockServer(
        [
            *_fill_with_reads(12),
            call_reply('read_workspace_file', {'relative_path': 'notes.txt', 'start_line': 1, 'end_line': 20}, 'r'),
            call_reply('write_workspace_file', {'relative_path': 'notes.txt'}, 'failed'),
            call_reply('replace_workspace_lines', blind, 'blind'),
            text_reply('done'),
        ]
    )
    graph = real_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    results = _edit_results(await thread_messages(graph, thread()), 'replace_workspace_lines')
    assert results[0].startswith('Tool error: `notes.txt` lines 200-210 are not in your context.')
    assert 'BLIND' not in (workspace / 'notes.txt').read_text(encoding='utf-8')


# ---------------------------------------------------------------------------
# Stop
# ---------------------------------------------------------------------------


def _stop_when_notes_start(server: MockServer, sess: SessionState) -> list[asyncio.Task]:
    """Press Stop while the notes call streams: ``/chat/abort`` sets the event and closes the response."""
    tasks: list[asyncio.Task] = []

    def on_request(body: dict) -> None:
        if is_summary_request(body) and not tasks:
            loop = asyncio.get_running_loop()
            tasks.append(loop.create_task(_abort_soon(sess)))

    server.on_request = on_request
    return tasks


async def _abort_soon(sess: SessionState) -> None:
    await asyncio.sleep(0.05)
    await ht.abort_in_flight_generation(sess, _SID)


async def test_stop_mid_summary_sends_no_second_request(session: SessionState) -> None:
    """The graph on its own, so no pump cancel comes to the rescue: the closed stream is what it sees."""
    window = small_window(session)
    set_window(window)
    slow_notes = text_reply('NEXT STEP: never finished. ' * 20, delay=0.05)
    server = MockServer(read_script(10, 6000), summaries=[slow_notes])
    graph = fake_graph(server, session)
    tasks = _stop_when_notes_start(server, session)

    _state, lines, error = await run_graph(graph, thread(), user_turn())
    await asyncio.gather(*tasks)

    assert tasks, 'no notes call started'
    assert error is not None
    assert session.abort_event.is_set()
    assert 'read-after-close' in server.stream_log
    assert is_summary_request(server.requests[-1]), 'a request went out after Stop'
    assert 'never finished' not in ''.join(lines)
    assert not session.compaction_notes_call_open
    # The event left nothing behind: messages intact, the step re-runs next turn.
    snapshot = await graph.aget_state(thread())
    assert not snapshot.values.get('context_compaction', {}).get('cut_id')
    assert isinstance(snapshot.values['messages'][-1], ToolMessage)
    # Nothing was compacted, so nothing says so: the stopped turn settles the running pill as stopped.
    states = [item[1]['data']['status']['state'] for item in drain(session.planning_nested_events_q)]
    assert states == ['running']


async def test_stop_after_summary_finished_sends_no_second_request(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)

    def on_request(body: dict) -> None:
        # Stop lands while the notes call runs but after its stream could still finish normally.
        if is_summary_request(body):
            session.abort_event.set()

    server.on_request = on_request

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is not None
    assert is_summary_request(server.requests[-1])


async def test_stop_before_the_notes_call_sends_nothing(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)
    session.abort_event.set()

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is not None
    assert server.summary_requests() == []
    assert not any(BLOCK_HEADER in str(body['messages'][1]['content']) for body in server.requests)


async def test_stop_mid_summary_through_the_whole_turn(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000), summaries=[text_reply('NEXT STEP: never finished. ' * 20, delay=0.05)])
    tasks = _stop_when_notes_start(server, session)
    outcome = LangGraphWorkerOutcome()

    lines = await composer_turn(server, 'go', outcome=outcome)
    await asyncio.gather(*tasks)

    assert outcome.state == AgentLoopOutcome.ABORTED
    assert is_summary_request(server.requests[-1])
    pills = [status for status in sse_statuses(lines) if status['label'] == COMPACT_PILL_LABEL]
    assert pills and pills[-1]['state'] == 'running'
    # A stopped turn keeps its thread; the next turn pays for the summary again and goes on.
    server.on_request = None
    server.script = [text_reply('finished after stop')]
    outcome = LangGraphWorkerOutcome()
    await composer_turn(server, 'go on', outcome=outcome)
    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == 'finished after stop'
    assert_valid_view(server.agent_requests()[-1])


async def test_summary_error_without_stop_still_runs_the_agent_call(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))

    def fail_notes(body: dict) -> httpx.Response:
        del body
        raise httpx.ReadError('connection dropped')

    server.summaries = [fail_notes]
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'all done'
    assert not session.abort_event.is_set()
    assert not session.compaction_notes_call_open


async def test_stopping_a_subagent_during_its_notes_call_leaves_no_finished_pill(session: SessionState) -> None:
    """A child's lines ride the bus, which Stop does not close: nothing was compacted, so nothing may say so."""
    child_id = 'child-abcdef12'
    child = fork_subagent_session(_SID, session, child_id, 'scout')
    child.workspace_path = ''
    set_window(small_window(child))
    server = MockServer(read_script(10, 6000), summaries=[text_reply('NEXT STEP: never. ' * 40, delay=0.05)])
    notes_started = asyncio.Event()

    def on_request(body: dict) -> None:
        if is_summary_request(body):
            notes_started.set()

    server.on_request = on_request
    tap = SUBAGENT_BUS.subscribe()
    try:
        with turns_on(server):
            run = SubagentRun(
                parent_session_id=_SID,
                parent=session,
                child_id=child_id,
                child=child,
                name='scout',
                task_text='look',
                apply_mode=True,
            )
            run.announced.set()
            task = start_subagent(run)
            await asyncio.wait_for(notes_started.wait(), 30)
            await asyncio.sleep(0.05)
            await chat_abort(AbortRequest(session_id=child_id))
            await asyncio.wait_for(asyncio.wait({task}), 15)
        events = [event for event in drain(tap) if event.get('conversation_id') == child_id]
    finally:
        SUBAGENT_BUS.unsubscribe(tap)

    payloads = [event['payload'] for event in events if event['type'] == 'subagent_event']
    statuses = [payload['status'] for payload in payloads if payload.get('type') == 'status']
    assert [status['state'] for status in statuses if status['label'] == COMPACT_PILL_LABEL] == ['running']
    assert [event['outcome'] for event in events if event['type'] == 'subagent_finished'] == ['aborted']


async def test_an_event_that_fails_without_a_stop_still_finishes_its_pill(session: SessionState) -> None:
    """That turn ends with ``[DONE]``, which settles nothing: the pill must not stay running."""
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)

    with patch.object(compaction_middleware, 'block_text', side_effect=RuntimeError('boom')):
        _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is not None
    states = [item[1]['data']['status']['state'] for item in drain(session.planning_nested_events_q)]
    assert states == ['running', 'complete']


async def test_a_live_notes_call_does_not_trip_the_stall_watchdog(session: SessionState) -> None:
    """Its chunks reach no queue, so the watchdog only sees silence; the HTTP idle timeout is what bounds it."""
    window = small_window(session)
    set_window(window)
    open_during: list[bool] = []
    slow_notes = text_reply('NEXT STEP: go on with it now. ' * 25, delay=0.05)
    server = MockServer(read_script(10, 6000), n_ctx=window, summaries=[slow_notes])

    def on_request(body: dict) -> None:
        open_during.append(is_summary_request(body) == session.compaction_notes_call_open)

    server.on_request = on_request
    outcome = LangGraphWorkerOutcome()

    with patch.object(graph_module, '_stream_watchdog_timeout_sec', lambda: 0.5):
        await composer_turn(server, 'go', outcome=outcome)

    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == 'all done'
    assert server.summary_requests()
    assert open_during and all(open_during)
    assert not session.compaction_notes_call_open
    assert (await saved_thread())['messages']


# ---------------------------------------------------------------------------
# Disabled
# ---------------------------------------------------------------------------


async def test_disabled_runs_no_event_but_keeps_truncation_budget_and_thinking_bound(session: SessionState) -> None:
    runtime_config.context_compression.enabled = False
    window = small_window(session)
    set_window(window)
    big = call_reply('read_workspace_file', {'relative_path': 'p.txt', 'size': 400_000}, 'big')
    cut_off = call_reply('read_thing', '{"path": "a', 'cut', finish='length')
    server = MockServer([big, *read_script(6, 6000, final=''), cut_off])
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert compressed_events(session) == []
    assert server.summary_requests() == []
    assert all(BLOCK_HEADER not in json.dumps(body) for body in server.requests)
    # Nothing was cut.
    cc = await private_state(graph, thread())
    assert 'cut_id' not in cc
    # Truncation: the cut-off call never ran and ended the turn. Budget: the giant read came back shortened.
    assert session.harness_final_text == _TRUNCATED_STOP_TEXT
    messages = await thread_messages(graph, thread())
    results = [m for m in messages if isinstance(m, ToolMessage)]
    assert 'cut' not in {m.tool_call_id for m in results}
    assert len(results[0].content) < 400_000 // 2
    assert 'start_line=' in results[0].content
    # Thinking bound.
    assert all(body['reasoning_budget_tokens'] >= 512 for body in server.requests)


async def test_disabled_does_not_retry_an_overflow(session: SessionState) -> None:
    runtime_config.context_compression.enabled = False
    window = small_window(session)
    set_window(window)
    server = MockServer([*read_script(4, 2000, final=''), overflow_response(window + 9, window), text_reply('never')])
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is not None
    assert server.overflows == 1


async def test_guard_is_off_when_disabled_and_an_existing_cut_still_renders(
    session: SessionState, workspace: Path
) -> None:
    window = real_overhead(session) + 9000
    set_window(window)
    server = MockServer(
        [
            call_reply(
                'read_workspace_file', {'relative_path': 'notes.txt', 'start_line': 40, 'end_line': 60}, 'first-read'
            ),
            *_fill_with_reads(12),
            text_reply('turn one done'),
        ]
    )
    graph = real_graph(server, session)
    await run_graph(graph, thread(), user_turn())
    cc = await private_state(graph, thread())
    assert cc['cut_id']

    runtime_config.context_compression.enabled = False
    server.script = [
        call_reply(
            'replace_workspace_lines',
            {'relative_path': 'notes.txt', 'start_line': 40, 'end_line': 60, 'new_content': 'NO-GUARD'},
            'e',
        ),
        text_reply('turn two done'),
    ]
    graph = real_graph(server, session)
    await run_graph(graph, thread(), user_turn('edit it'))

    assert 'NO-GUARD' in (workspace / 'notes.txt').read_text(encoding='utf-8')
    assert (await private_state(graph, thread()))['cut_id'] == cc['cut_id']
    assert BLOCK_HEADER in server.agent_requests()[-1]['messages'][1]['content']


# ---------------------------------------------------------------------------
# Recursion limit
# ---------------------------------------------------------------------------


async def test_recursion_limit_keeps_the_thread_and_the_next_turn_runs(session: SessionState) -> None:
    server = MockServer([call_reply('read_thing', {'path': str(i)}, f'c{i}') for i in range(40)])
    outcome = LangGraphWorkerOutcome()
    with patch.object(graph_module, 'MAX_AGENT_STEPS', 24):
        lines = await composer_turn(server, 'go', outcome=outcome)

    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text.startswith('Stopped: this turn reached the step limit')
    # Not an 'error' status: to the renderer that says the thread is gone, and it drops the context reading.
    assert any(s['state'] == 'complete' and s['detail'].startswith('Stopped: this turn') for s in sse_statuses(lines))
    assert not any(s['state'] == 'error' and s['source'] == 'agent' for s in sse_statuses(lines))
    assert any(p.get('type') == 'final_text' and p['text'] == outcome.final_text for p in sse_payloads(lines))
    assert session.history[-1]['content'] == outcome.final_text
    config = {'configurable': {'thread_id': ck.outer_agent_thread_id(_SID, 'single', apply_mode=True)}}
    saved = await ck.get_graph_checkpointer().aget_tuple(config)
    assert saved is not None
    steps = len(saved.checkpoint['channel_values']['messages'])
    assert steps > 3

    server.script = [text_reply('continued')]
    outcome = LangGraphWorkerOutcome()
    await composer_turn(server, 'continue', outcome=outcome)

    assert outcome.final_text == 'continued'
    assert_valid_view(server.requests[-1])


# ---------------------------------------------------------------------------
# Futility, the nudge, packs, settings per provider, tool budget
# ---------------------------------------------------------------------------


async def test_events_without_progress_hint_halve_the_cap_then_stop(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    reads = [call_reply('read_thing', {'path': 'same', 'size': 14000}, f'c{i}') for i in range(60)]
    server = MockServer(reads, n_ctx=window)
    graph = fake_graph(server, session)
    outcome_text = 'Stopped: the context filled up again and again'

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert session.harness_final_text.startswith(outcome_text)
    # No model call for the stop, and the turn ended well before the script did.
    assert server.script
    messages = await thread_messages(graph, thread())
    assert messages[-1].content.startswith(outcome_text)
    assert messages[-1].tool_calls == []
    assert state.last_final_text == ''
    # The hint appeared in an earlier block.
    blocks = [str(body['messages'][1]['content']) for body in server.agent_requests()]
    assert any('of tool output, and the last reads found nothing new.' in block for block in blocks)
    assert 'of tool output' not in block_of(first_with_block(server.agent_requests()))
    # After the first futile event the same read returned half as much.
    cc = await private_state(graph, thread())
    assert cc['futile'] == 0
    sizes = [len(m.content) for m in messages if isinstance(m, ToolMessage)]
    assert min(sizes) < max(sizes)


async def test_progress_ends_a_futile_streak(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    repeats = [call_reply('read_thing', {'path': 'same', 'size': 14000}, f'c{i}') for i in range(9)]
    fresh = read_script(8, 8000, start=100)
    server = MockServer([*repeats, *fresh], n_ctx=window)
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'all done'
    blocks = [str(body['messages'][1]['content']) for body in server.agent_requests()]
    assert any('of tool output, and the last reads found nothing new' in block for block in blocks)
    assert 'of tool output, and the last reads found nothing new' not in blocks[-1]
    assert (await private_state(graph, thread()))['futile'] == 0


async def test_new_calls_of_other_tools_are_progress(session: SessionState) -> None:
    """A web page or an MCP operation is not a file read, and it is not going in circles either."""
    window = small_window(session)
    set_window(window)
    reads = [call_reply('read_thing', {'path': str(i), 'size': 14000}, f'c{i}') for i in range(30)]
    server = MockServer([*reads, text_reply('done')], n_ctx=window)
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'done'
    assert session.harness_final_text == ''
    assert len(compressed_events(session)) >= 4


async def test_the_next_turn_after_a_futile_stop_runs(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    reads = [call_reply('read_thing', {'path': 'same', 'size': 14000}, f'c{i}') for i in range(60)]
    server = MockServer(reads, n_ctx=window)
    outcome = LangGraphWorkerOutcome()
    await composer_turn(server, 'go', outcome=outcome)
    assert outcome.final_text.startswith('Stopped: the context filled up')
    requests = len(server.requests)

    server.script = [text_reply('fresh answer')]
    outcome = LangGraphWorkerOutcome()
    await composer_turn(server, 'try something else', outcome=outcome)

    assert outcome.final_text == 'fresh answer'
    assert session.harness_final_text == ''
    assert len(server.requests) > requests


_FUTILE_HINT = 'the last reads found nothing new'


def _hinted(body: dict) -> bool:
    return _FUTILE_HINT in json.dumps(body['messages'], ensure_ascii=False)


def _same_read(*replies_once_hinted: dict) -> Callable[[dict], dict]:
    """The same file over and over, then the given replies once the block says it found nothing new."""
    counter = itertools.count()
    replies = list(replies_once_hinted)

    def reply(body: dict) -> dict:
        if replies and _hinted(body):
            return replies.pop(0)
        return call_reply('read_workspace_file', {'relative_path': 'same.txt', 'size': 14000}, f'c{next(counter)}')

    return reply


async def test_a_later_request_going_over_old_files_again_is_progress(session: SessionState) -> None:
    """Their text was cut, and this request needs it: no hint, no half-size results, and no stop."""
    window = small_window(session)
    set_window(window)
    size = int(0.1 * window * _CHARS_PER_TOKEN)

    def reads(tag: str) -> list[dict]:
        return [
            call_reply('read_workspace_file', {'relative_path': f'p{number}.txt', 'size': size}, f'{tag}{number}')
            for number in range(16)
        ]

    server = MockServer([*reads('a'), text_reply('first answer')], n_ctx=window)
    graph = fake_graph(server, session)
    await run_graph(graph, thread(), user_turn('Review all these files.'))
    start = len(server.requests)
    server.script = [*reads('b'), text_reply('second answer')]

    state, _lines, error = await run_graph(graph, thread(), user_turn('Now check them all again for a race.'))

    assert error is None
    assert state.last_final_text == 'second answer'
    assert session.harness_final_text == ''
    assert not any(_hinted(body) for body in server.requests[start:])
    results = {m.tool_call_id: m.content for m in await thread_messages(graph, thread()) if isinstance(m, ToolMessage)}
    assert all(results[f'b{number}'] == results[f'a{number}'] for number in range(16))
    assert (await private_state(graph, thread()))['futile'] == 0


async def test_a_read_loop_in_a_later_request_still_stops(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer([text_reply('first')], n_ctx=window)
    graph = fake_graph(server, session)
    await run_graph(graph, thread(), user_turn('hello'))
    reply = _same_read()
    server.script = [reply for _ in range(60)]

    await run_graph(graph, thread(), user_turn('read it'))

    assert session.harness_final_text == _FUTILE_STOP_TEXT
    assert server.script


async def test_a_thread_with_no_tools_never_gets_the_hint(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer([text_reply('x' * 16000) for _ in range(10)])
    graph = fake_graph(server, session)

    for number in range(10):
        await run_graph(graph, thread(), user_turn(f'question {number}'))

    assert len(compressed_events(session)) >= 3
    assert not any(_hinted(body) for body in server.requests)
    assert not (await private_state(graph, thread())).get('futile')


async def test_the_first_request_after_a_futile_event_does_not_get_its_hint(session: SessionState) -> None:
    """The block stays until the next event: 'stop reading' would otherwise reach a request that needs reads."""
    window = small_window(session)
    set_window(window)
    reply = _same_read(text_reply('I stopped reading.'))
    server = MockServer([reply for _ in range(60)], n_ctx=window)
    graph = fake_graph(server, session)
    state, _lines, _error = await run_graph(graph, thread(), user_turn('Read same.txt.'))
    assert state.last_final_text == 'I stopped reading.'
    assert not session.harness_final_text
    assert _hinted(server.agent_requests()[-1])
    cc = await private_state(graph, thread())
    assert cc['hint'] and cc['hint'] in cc['block']
    start = len(server.requests)
    compressed_events(session)
    server.script = [call_reply('read_thing', {'path': 'other'}, 'other'), text_reply('short answer')]

    state, _lines, error = await run_graph(graph, thread(), user_turn('A short new question.'))

    assert error is None
    assert state.last_final_text == 'short answer'
    assert compressed_events(session) == []
    bodies = server.requests[start:]
    assert not any(_hinted(body) for body in bodies)
    # Only the hint went from the block, and the view is stable again from there on.
    assert all(BLOCK_HEADER in body['messages'][1]['content'] for body in bodies)
    assert is_prefix(bodies[0], bodies[1])
    assert 'hint' not in await private_state(graph, thread())


async def test_the_first_event_of_a_new_request_is_not_futile(session: SessionState) -> None:
    """Turn one's last event is on its last call, so nothing changes before turn two's paste brings another."""
    window = small_window(session)
    set_window(window)
    counter = itertools.count()

    def until_an_event(body: dict) -> dict:
        del body
        if session.hitl_sse_queue.qsize():
            return text_reply('first answer')
        number = next(counter)
        return call_reply('read_workspace_file', {'relative_path': f'p{number}.txt', 'size': 6000}, f'r{number}')

    server = MockServer([until_an_event for _ in range(30)], n_ctx=window)
    graph = fake_graph(server, session)
    await run_graph(graph, thread(), user_turn('Read the files.'))
    assert not session.harness_final_text
    drain(session.hitl_sse_queue)
    start = len(server.requests)
    # Between the halved cap and the whole one.
    size = int(0.15 * window * 3.2)
    server.script = [call_reply('read_thing', {'path': 'log', 'size': size}, 'whole'), text_reply('second answer')]

    await run_graph(graph, thread(), user_turn('A new request with a paste: ' + 'pasted text ' * (window // 8)))

    assert compressed_events(session), 'no event on the new request'
    assert not any(_hinted(body) for body in server.requests[start:])
    messages = await thread_messages(graph, thread())
    assert len(next(m for m in messages if isinstance(m, ToolMessage) and m.tool_call_id == 'whole').content) == size


async def test_a_paste_after_a_chat_with_no_tools_gets_no_hint_and_whole_results(session: SessionState) -> None:
    """No tool in the last turn or before this request's first event: their counts match, and yet nothing was tried."""
    window = small_window(session)
    set_window(window)
    server = MockServer([text_reply('x' * 16000) for _ in range(4)])
    graph = fake_graph(server, session)
    for number in range(4):
        await run_graph(graph, thread(), user_turn(f'question {number}'))
    assert compressed_events(session)
    start = len(server.requests)
    # Between the halved cap and the whole one.
    size = int(0.15 * window * 3.2)
    server.script = [call_reply('read_thing', {'path': 'log', 'size': size}, 'whole'), text_reply('answer')]

    await run_graph(graph, thread(), user_turn('Look at this log: ' + 'pasted text ' * (window // 8)))

    assert compressed_events(session), 'no event on the new request'
    assert not any(_hinted(body) for body in server.requests[start:])
    messages = await thread_messages(graph, thread())
    assert len(next(m for m in messages if isinstance(m, ToolMessage) and m.tool_call_id == 'whole').content) == size


class _ChildGatedServer(MockServer):
    """A sub-agent's request waits on ``gate`` and gets its own reply; everything else is the parent's script."""

    def __init__(self, script: list[Any], *, n_ctx: int, gate: asyncio.Event) -> None:
        super().__init__(script, n_ctx=n_ctx)
        self.gate = gate
        self.child = MockServer([text_reply('Scout found things.')])

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if 'sub-agent** named' in json.dumps(json.loads(request.content)['messages'][0]):
            await self.gate.wait()
            return await self.child.handler(request)
        return await super().handler(request)


def _tools_with_spawn(apply_mode: bool, *, session: Any = None, include_subagent_tool: bool = False):
    del apply_mode, include_subagent_tool
    tools = list(_FAKE_TOOLS)
    if session is not None and not session.subagent_parent_session_id:
        tools.append(spawn_subagent_tool)
    return tools, {t.name: t for t in tools}


async def _turn_with_a_background_child(
    sess: SessionState, after_report: Callable[[dict], dict]
) -> LangGraphWorkerOutcome:
    """The parent spawns in the background and repeats one read: the child answers when the turn starts waiting."""
    window = small_window(sess)
    set_window(window)
    counter = itertools.count()

    def parent(body: dict) -> dict:
        if REPORTS_ARRIVED_HEADER in json.dumps(body['messages'], ensure_ascii=False):
            return after_report(body)
        return call_reply('read_thing', {'path': 'same', 'size': 14000}, f'r{next(counter)}')

    gate = asyncio.Event()
    spawn = call_reply('spawn_subagent', {'task': 'look around', 'name': 'scout', 'background': True}, 's1')
    server = _ChildGatedServer([spawn, *[parent for _ in range(120)]], n_ctx=window, gate=gate)
    outcome = LangGraphWorkerOutcome()
    with turns_on(server, _tools_with_spawn):
        async for line in stream_agent_reply(_SID, 'go', apply_mode=True, outcome_sink=outcome):
            if '"wait_for_subagents"' in line and '"running"' in line:
                gate.set()
    await stop_all_subagents()
    await asyncio.sleep(0.05)
    return outcome


async def test_a_futile_stop_the_subagent_wait_sends_on_gives_way_to_the_real_answer(session: SessionState) -> None:
    """The stop is an ordinary reply to the after-model hooks: a report can send it back to the model."""
    real = 'the real answer after the report'

    outcome = await asyncio.wait_for(_turn_with_a_background_child(session, lambda _body: text_reply(real)), 120)

    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == real
    assert session.history[-1]['content'] == real
    messages = (await saved_thread())['messages']
    assert messages[-1].content == real
    assert any(m.content == _FUTILE_STOP_TEXT for m in messages)


async def test_a_second_futile_stop_with_no_subagent_left_stands(session: SessionState) -> None:
    counter = itertools.count()

    def keep_reading(_body: dict) -> dict:
        return call_reply('read_thing', {'path': 'same', 'size': 14000}, f'again{next(counter)}')

    outcome = await asyncio.wait_for(_turn_with_a_background_child(session, keep_reading), 120)

    assert outcome.final_text == _FUTILE_STOP_TEXT
    assert session.history[-1]['content'] == _FUTILE_STOP_TEXT


async def test_harness_text_of_the_last_turn_does_not_leak_into_the_next(session: SessionState) -> None:
    session.harness_final_text = 'stale'
    server = MockServer([text_reply('real answer')])
    outcome = LangGraphWorkerOutcome()

    await composer_turn(server, 'go', outcome=outcome)

    assert outcome.final_text == 'real answer'


async def test_a_text_reply_after_a_mid_turn_cut_ends_the_turn(session: SessionState) -> None:
    """Whatever the first text-only reply after an event says is the answer: it is never sent back."""
    window = small_window(session)
    set_window(window)

    def agent(body: dict) -> dict:
        reads = sum(1 for message in body['messages'] if message['role'] == 'tool')
        if BLOCK_HEADER in str(body['messages'][1]['content']):
            return text_reply('Understood, I will continue.')
        return call_reply(
            'read_workspace_file',
            {'relative_path': f'p{reads}{len(body["messages"])}.txt', 'size': 6000},
            f'c{len(body["messages"])}',
        )

    server = MockServer([agent] * 30)
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert compressed_events(session)
    assert state.last_final_text == 'Understood, I will continue.'
    assert server.agent_requests()[-1]['messages'][-1]['role'] == 'tool'
    assert not any(item[0] == 'agent_nudge' for item in drain(session.hitl_sse_queue))


async def test_a_futile_stop_replaces_whatever_the_model_would_have_said(session: SessionState) -> None:
    """The third event without progress ends the turn with the notice alone: no model call follows."""
    window = small_window(session)
    set_window(window)
    counter = itertools.count()

    def agent(body: dict) -> dict:
        del body
        return call_reply('read_thing', {'path': 'same', 'size': 14000}, f'c{next(counter)}')

    server = MockServer([agent for _ in range(60)], n_ctx=window)
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    assert session.harness_final_text == _FUTILE_STOP_TEXT
    assert (await thread_messages(graph, thread()))[-1].content == _FUTILE_STOP_TEXT


async def test_promoted_xml_call_after_a_cut_runs(session: SessionState) -> None:
    """A call written as XML right after an event is promoted and runs; the reply after it is the answer."""
    window = small_window(session)
    set_window(window)
    xml = '<tool_call><function=read_thing><parameter=path>promoted</parameter></function></tool_call>'

    def agent(body: dict) -> dict:
        last = body['messages'][-1]
        if last['role'] == 'tool' and 'promoted' in last['content']:
            return text_reply('Done after the promoted call.')
        if BLOCK_HEADER in str(body['messages'][1]['content']):
            return text_reply(xml)
        return call_reply(
            'read_workspace_file',
            {'relative_path': f'p{len(body["messages"])}.txt', 'size': 6000},
            f'c{len(body["messages"])}',
        )

    server = MockServer([agent] * 30)
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    messages = await thread_messages(graph, thread())
    assert any(isinstance(m, ToolMessage) and 'promoted' in m.content for m in messages)
    assert state.last_final_text == 'Done after the promoted call.'


async def test_a_turn_counts_as_new_with_notes_after_the_request() -> None:
    from clara_coder_backend.middleware.context_compaction_middleware import _turn_just_started

    report = HumanMessage(content='A report arrived.')
    assert _turn_just_started([AIMessage(content='old answer'), user_turn(), report])
    assert not _turn_just_started([user_turn(), AIMessage(content='reply'), report])
    assert not _turn_just_started([user_turn(), AIMessage(content='reply')])
    assert not _turn_just_started([report])
    assert not _turn_just_started([])


async def test_packs_whose_text_left_the_view_can_activate_again(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    script = [
        call_reply('pack_thing', {'pack': 'old-pack'}, 'pack-old'),
        *read_script(6, 6000, final=''),
        call_reply('pack_thing', {'pack': 'new-pack'}, 'pack-new'),
        *read_script(1, 400, final='', start=20),
        text_reply('done'),
    ]
    server = MockServer(script)
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    assert compressed_events(session)
    assert session.activated_context_packs == {'new-pack'}


async def test_user_event_notes_stay_last_in_the_view(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(
        [
            *read_script(8, 6000, final=''),
            call_reply('note_thing', {'note': 'A note for one call'}, 'n'),
            *read_script(5, 6000, start=30),
        ]
    )
    graph = fake_graph(server, session)

    _state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    with_note = next(
        body for body in server.agent_requests() if body['messages'][-1].get('content') == 'A note for one call'
    )
    assert with_note['messages'][-2]['role'] == 'tool'
    assert_valid_view(with_note)


async def test_status_pill_and_context_compressed_payloads(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    pills = [item for item in drain(session.planning_nested_events_q) if item[1].get('event') == 'subagent_sse']
    running, complete = pills[0][1]['data']['status'], pills[1][1]['data']['status']
    assert pills[0][0] == f'compact:{running["id"]}'
    assert running['label'] == complete['label'] == COMPACT_PILL_LABEL
    assert running['id'] == complete['id']
    assert (running['state'], complete['state']) == ('running', 'complete')
    assert complete['source'] == 'tool'
    assert re.fullmatch(r'\d+\.\dK → \d+\.\dK tokens', complete['detail'])
    assert isinstance(complete['duration_ms'], int)
    event = compressed_events(session)[0]
    assert set(event) == {'type', 'tokens_before', 'tokens_after', 'tool_messages_compacted', 'tool_rounds_dropped'}
    assert event['type'] == 'context_compressed'
    assert event['tokens_before'] > event['tokens_after'] > overhead_tokens(session) // 2
    assert event['tool_messages_compacted'] >= 1
    assert event['tool_rounds_dropped'] >= 1


async def test_event_with_no_stream_attached(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    session.hitl_sse_queue = None
    session.planning_nested_events_q = None
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)

    state, _lines, error = await run_graph(graph, thread(), user_turn())

    assert error is None
    assert state.last_final_text == 'all done'
    assert block_of(first_with_block(server.agent_requests()))


async def test_no_gain_backs_off_without_an_event(session: SessionState) -> None:
    """One giant request and nothing else: a cut would remove nothing, so no event, and the check backs off."""
    window = small_window(session)
    set_window(window)
    server = MockServer([text_reply('answer')])
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn('q' * (int(window * 0.9) * 4)))

    assert compressed_events(session) == []
    assert drain(session.planning_nested_events_q) == []
    assert server.summary_requests() == []
    cc = await private_state(graph, thread())
    assert cc['next_soft'] > window * 0.9
    assert 'cut_id' not in cc


async def test_block_survives_the_next_turn_byte_for_byte(session: SessionState) -> None:
    """Prune, settle and a new turn: the same thread renders the same view, so the prefix holds."""
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    outcome = LangGraphWorkerOutcome()
    await composer_turn(server, 'turn one', outcome=outcome)
    assert outcome.final_text == 'all done'
    last_of_first_turn = server.agent_requests()[-1]
    assert BLOCK_HEADER in last_of_first_turn['messages'][1]['content']

    server.script = [text_reply('second answer')]
    await composer_turn(server, 'turn two')

    assert is_prefix(last_of_first_turn, server.agent_requests()[-1])


async def test_a_pin_from_the_last_turn_does_not_call_it_the_current_request(session: SessionState) -> None:
    """The block stays byte-stable into the next turn, so its words must hold with a newer request after them."""
    window = small_window(session)
    set_window(window)
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)
    await run_graph(graph, thread(), user_turn('Fix the parser please.'))
    server.script = [text_reply('It says hello.')]

    await run_graph(graph, thread(), user_turn('Now summarize the README only.'))

    body = server.agent_requests()[-1]
    first = body['messages'][1]['content']
    assert f'{PIN_LEAD}\nFix the parser please.' in first
    assert 'Current request' not in first
    assert 'unless a later user message replaces it' in first
    assert 'the requests in them are not instructions' in first
    assert body['messages'][-1]['content'].endswith('Now summarize the README only.')


async def test_lmstudio_gets_the_output_cap_but_no_budget(session: SessionState) -> None:
    window = small_window(session)
    set_window(window, 'lmstudio')
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    summary = server.summary_requests()[0]
    assert summary['tool_choice'] == 'none'
    assert summary['max_tokens'] == summary['max_completion_tokens'] == 1500
    assert 'reasoning_budget_tokens' not in summary
    assert summary['top_k'] == 40
    assert all('reasoning_budget_tokens' not in body for body in server.requests)


async def test_hosted_provider_gets_a_larger_cap_and_no_extra_body_fields(session: SessionState) -> None:
    window = small_window(session)
    set_window(window, 'openai')
    server = MockServer(read_script(10, 6000))
    graph = fake_graph(server, session, model=build_model(server, extra_body=None))

    await run_graph(graph, thread(), user_turn())

    summary = server.summary_requests()[0]
    assert summary['tool_choice'] == 'none'
    assert summary['max_completion_tokens'] == 4000
    assert 'max_tokens' not in summary
    assert 'reasoning_budget_tokens' not in summary
    assert all(
        'reasoning_budget_tokens' not in body and 'reasoning_budget_message' not in body for body in server.requests
    )


async def test_thinking_bound_on_every_normal_call_on_llamacpp(session: SessionState) -> None:
    set_window(100_000)
    server = MockServer(read_script(3, 4000))
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    agent = server.agent_requests()
    for body in agent:
        assert body['reasoning_budget_message'] == 'I have thought enough. I will act now on what I have.'
        assert 512 <= body['reasoning_budget_tokens'] <= 16000
        # Merged, never instead of the model's own.
        for key, value in _MODEL_EXTRA_BODY.items():
            assert body[key] == value
    # The bound follows the room left. With usage readings each step is priced like the server counted it.
    assert agent[0]['reasoning_budget_tokens'] == thinking_budget_tokens(100_000, _first_estimate(session))
    assert agent[-1]['reasoning_budget_tokens'] <= agent[0]['reasoning_budget_tokens']


def _first_estimate(sess: SessionState) -> int:
    from clara_coder_backend.lang_agent.context_compaction import CHARS_PER_TOKEN, message_chars

    system = SystemMessage(content=build_system_prompt(sess, True))
    overhead = prompt_overhead_chars(system, _FAKE_TOOLS)
    return int((overhead + message_chars(user_turn())) / CHARS_PER_TOKEN)


async def test_thinking_bound_shrinks_to_its_floor_near_the_window(session: SessionState) -> None:
    window = small_window(session)
    set_window(window)
    server = MockServer([text_reply('answer')])
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn('q' * (window * 4)))

    assert server.agent_requests()[0]['reasoning_budget_tokens'] == 512


async def test_thinking_bound_leaves_room_for_the_answer_under_a_settings_cap(session: SessionState) -> None:
    """Above the cap the model reaches it inside its thought: no answer, discarded, and the turn stops."""
    set_window(65536)
    server = MockServer([text_reply('done')])
    graph = fake_graph(server, session, model=build_model(server, max_tokens=6000))

    await run_graph(graph, thread(), user_turn())

    assert server.requests[0]['max_completion_tokens'] == 6000
    assert server.requests[0]['reasoning_budget_tokens'] == 2000


async def test_tool_results_are_budgeted_per_call_in_the_step(session: SessionState) -> None:
    set_window(40_000)
    one = call_reply('read_workspace_file', {'relative_path': 'a.txt', 'size': 400_000}, 'one')
    two = calls_reply(
        ('read_workspace_file', {'relative_path': 'b.txt', 'size': 400_000}, 'two-a'),
        ('read_thing', {'path': 'c', 'size': 400_000}, 'two-b'),
    )
    server = MockServer([one, two, text_reply('done')])
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    messages = await thread_messages(graph, thread())
    results = {m.tool_call_id: m.content for m in messages if isinstance(m, ToolMessage)}
    assert len(results['one']) < 0.2 * 40_000 * 3.2 + 200
    # Reads keep their head and say how to go on.
    match = re.search(r'To see more, call again with start_line=(\d+)\.\]$', results['one'])
    assert match is not None
    assert f'\n{int(match.group(1)) - 1:>4} │ ' in results['one']
    assert f'\n{int(match.group(1)):>4} │ ' not in results['one']
    # Others keep head and tail.
    assert 'chars omitted' in results['two-b']
    room = (40_000 - 6000 - overhead_tokens(session) * _CHARS_PER_TOKEN / 3.2) * 3.2 / 2
    assert len(results['two-a']) <= room + 200
    assert len(results['two-b']) <= room + 200


async def test_tool_results_leave_room_for_the_system_prompt_and_tools(session: SessionState) -> None:
    window = overhead_tokens(session) + 5000
    set_window(window)
    batch = calls_reply(
        ('read_thing', {'path': 'a', 'size': 400_000}, 'one'),
        ('read_thing', {'path': 'b', 'size': 400_000}, 'two'),
    )
    server = MockServer([batch, text_reply('done')])
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    messages = await thread_messages(graph, thread())
    results = [m.content for m in messages if isinstance(m, ToolMessage)]
    overhead = overhead_tokens(session) * _CHARS_PER_TOKEN / 3.2
    room = (window - 2048 - overhead) * 3.2 / 2
    assert room < 0.2 * window * 3.2
    assert all(room * 0.9 < len(result) <= room + 100 for result in results)


async def test_approved_command_output_is_budgeted(session: SessionState) -> None:
    """The approved output is folded into the result by the review middleware: the budget must sit outside it."""
    set_window(40_000)
    server = MockServer([call_reply('run_command', {'command': 'npm test'}, 'cmd'), text_reply('done')])
    graph = fake_graph(server, session)
    output = 'OUTPUT-START ' + 'o' * 400_000 + ' OUTPUT-END'

    async def answer_card() -> None:
        while session.agent_pause_event is None:
            await asyncio.sleep(0.01)
        session.agent_pause_note = output
        session.agent_pause_event.set()

    answering = asyncio.create_task(answer_card())
    _state, _lines, error = await asyncio.wait_for(run_graph(graph, thread(), user_turn()), 30)
    answering.cancel()

    assert error is None
    messages = await thread_messages(graph, thread())
    result = next(m for m in messages if isinstance(m, ToolMessage))
    assert 'OUTPUT-END' in result.content
    assert 'chars omitted' in result.content
    assert len(result.content) < 0.2 * 40_000 * 3.2 + 200


async def test_small_tool_results_are_the_same_message(session: SessionState) -> None:
    server = MockServer(read_script(1, 400))
    graph = fake_graph(server, session)

    await run_graph(graph, thread(), user_turn())

    messages = await thread_messages(graph, thread())
    result = next(m for m in messages if isinstance(m, ToolMessage))
    assert result.content == fake_read_file.invoke({'relative_path': 'p0.txt', 'size': 400})


async def test_a_command_result_is_budgeted_message_by_message() -> None:
    result = ToolMessage(content='x' * 9000, tool_call_id='c', name='delete_workspace_entries')
    note = HumanMessage(content='n' * 9000)
    command = Command(update={'messages': [result, note]})

    capped = _capped_result(command, 'delete_workspace_entries', 2000)

    assert isinstance(capped, Command)
    assert len(capped.update['messages'][0].content) < 2200
    assert capped.update['messages'][1] is note
    small = Command(update={'messages': [ToolMessage(content='ok', tool_call_id='c', name='n')]})
    assert _capped_result(small, 'n', 2000) is small


@pytest.mark.parametrize('metadata', [{'finish_reason': 'length'}, {'stop_reason': 'max_tokens'}])
async def test_truncation_hook_on_both_metadata_forms_strips_everything_but_the_id(
    session: SessionState, metadata: dict
) -> None:
    last = AIMessage(
        content=[{'type': 'text', 'text': 'partial'}],
        id='the-id',
        tool_calls=[{'name': 'write_workspace_file', 'args': {'content': 'par'}, 'id': 'c', 'type': 'tool_call'}],
        invalid_tool_calls=[{'name': 'x', 'args': '{', 'id': 'd', 'error': 'bad', 'type': 'invalid_tool_call'}],
        additional_kwargs={
            'reasoning_content': 'thoughts',
            'reasoning_details': [{'type': 'reasoning.encrypted'}],
            'tool_calls': [{}],
        },
        response_metadata=metadata,
    )
    original = last.model_copy(deep=True)

    update = await ContextCompactionMiddleware().aafter_model({'messages': [user_turn(), last]}, None)

    assert update['jump_to'] == 'end'
    (replaced,) = update['messages']
    assert replaced.id == 'the-id'
    assert replaced.tool_calls == [] and replaced.invalid_tool_calls == []
    assert replaced.content == session.harness_final_text == _TRUNCATED_STOP_TEXT
    assert replaced.additional_kwargs == {'reasoning_content': 'thoughts'}
    assert 'context_compaction' not in update
    assert last == original


async def test_truncation_hook_ignores_everything_else(session: SessionState) -> None:
    middleware = ContextCompactionMiddleware()
    assert await middleware.aafter_model({'messages': [AIMessage(content='fine')]}, None) is None
    assert await middleware.aafter_model({'messages': [HumanMessage(content='x')]}, None) is None
    assert await middleware.aafter_model({'messages': []}, None) is None


# ---------------------------------------------------------------------------
# Wiring outside the middleware
# ---------------------------------------------------------------------------


async def test_plan_execution_pins_less_of_its_long_prompt() -> None:
    with patch.object(pe, 'build_clara_single_outer_graph') as build:
        pe._plan_discovery_outer_graph_builder(object(), SessionState(), False, None)
        pe._plan_execute_outer_graph_builder(object(), SessionState(), True, None)
    discover, execute = build.call_args_list
    assert 'compaction_pin_ratio' not in discover.kwargs
    assert execute.kwargs['compaction_pin_ratio'] == 0.1


def _plan_md() -> str:
    return render_build_plan_md(
        BuildPlanModel(
            title='Feature plan',
            task='Build the feature',
            current_implementation='Legacy handler',
            files_to_change=[FileChangeEntry(path='src/app.ts', operation='modify', rationale='update')],
            action_steps=[ActionStep(id='step-1', goal='First'), ActionStep(id='step-2', goal='Second')],
        )
    )


async def _planner_md(*_args: Any, **kwargs: Any):
    kwargs['md_out'].clear()
    kwargs['md_out'].append(_plan_md())
    yield 'data: {"type":"build_plan_chunk"}\n\n'


@pytest.mark.parametrize(('marked', 'status'), [(['step-1'], 'active'), (['step-1', 'step-2'], 'complete')])
async def test_plan_completes_only_with_no_step_pending(tmp_path: Path, marked: list[str], status: str) -> None:
    from clara_coder_backend.plan.build_plan_store import get_active_plan, mark_steps_complete

    plan_session = SessionState(workspace_path=str(tmp_path))
    (tmp_path / 'src').mkdir()
    (tmp_path / 'src' / 'app.ts').write_text('// handler', encoding='utf-8')
    calls = {'n': 0}

    async def fake_exec(*_args: Any, **kwargs: Any):
        outcome: LangGraphWorkerOutcome = kwargs['outcome']
        calls['n'] += 1
        if calls['n'] == 2:
            record = get_active_plan(plan_session, chat_session_id='plan-sess')
            mark_steps_complete(str(tmp_path), record, marked)
        outcome.mark_completed(final_text='Understood, continuing.' if status == 'active' else 'All done.')
        yield 'data: {"type":"chunk"}\n\n'

    with (
        patch('clara_coder_backend.plan.plan_execute._stream_langgraph_tool_agent', side_effect=fake_exec),
        patch('clara_coder_backend.plan.plan_execute._stream_planner_md', side_effect=_planner_md),
        patch('clara_coder_backend.plan.plan_execute.await_diff_review_note', new=AsyncMock(return_value=None)),
    ):
        outcome = LangGraphWorkerOutcome()

        async def run_plan() -> None:
            async for _line in pe.stream_plan_execute_langgraph(
                plan_session, 'Build feature', True, session_id='plan-sess', outcome=outcome
            ):
                pass

        # A plan question it did not expect would wait for an answer forever.
        await asyncio.wait_for(run_plan(), 30)

    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert [entry['status'] for entry in _load_index(tmp_path)] == [status]


@pytest.mark.parametrize(
    ('provider', 'limit'), [('llamacpp', 1), ('lmstudio', 1), ('openai', CLARA_SUBAGENT_MAX_CONCURRENCY)]
)
async def test_subagent_concurrency_per_provider(session: SessionState, provider: str, limit: int) -> None:
    set_window(32768, provider)
    parent = SessionState()
    assert parent_subagent_semaphore(parent)._value == limit
    assert list(parent.subagent_semaphores.values()) == [parent_subagent_semaphore(parent)]


@pytest.mark.parametrize(
    ('base_url', 'limit'),
    [
        ('http://127.0.0.1:8080/v1', 1),
        ('http://localhost:8080/v1', 1),
        ('http://[::1]:8080/v1', 1),
        ('https://api.example.com/v1', CLARA_SUBAGENT_MAX_CONCURRENCY),
        ('', CLARA_SUBAGENT_MAX_CONCURRENCY),
    ],
)
async def test_subagent_concurrency_on_a_generic_server_follows_its_address(
    session: SessionState, base_url: str, limit: int
) -> None:
    set_window(32768, 'openai-compatible')
    runtime_config.connections[0].base_url = base_url
    assert parent_subagent_semaphore(SessionState())._value == limit


async def test_subagent_reports_are_capped_each(session: SessionState) -> None:
    set_window(20_000)
    reports = [
        SubagentReport(
            child_id=name, name=name, text=f'{name}-start ' + 'r' * 200_000 + f' {name}-end', outcome='completed'
        )
        for name in 'ab'
    ]
    text = format_subagent_reports(reports)
    assert 'a-start' in text and 'a-end' in text
    assert 'b-start' in text and 'b-end' in text
    assert 'chars omitted' in text
    assert len(text) < 0.2 * 20_000 * 3.2 * 2 + 800
