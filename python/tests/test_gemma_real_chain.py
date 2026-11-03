"""The Gemma preset on the real chain: composer, ``build_llm``, graph and tool registry. Only HTTP is fake.

:class:`_LlamaServer` applies the ``stop`` the factory put on the request the way ``llama-server`` does, and either
parses tool-call blocks into API ``tool_calls`` or, like a server whose parser leaves them, sends them as content.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import pytest_asyncio

from clara_coder_backend.composer import stream_agent_reply
from clara_coder_backend.domain import RuntimeConnection, RuntimeContextCompressionConfig, RuntimeToolsConfig
from clara_coder_backend.lang_agent.loop import AgentLoopOutcome, LangGraphWorkerOutcome
from clara_coder_backend.llm import http_transport as ht
from clara_coder_backend.llm.gemma_output import extract_gemma_native_tool_calls, strip_gemma_native_tool_call_blocks
from clara_coder_backend.session import checkpointing as ck
from clara_coder_backend.session.state import get_session, runtime_config

pytestmark = pytest.mark.asyncio(loop_scope='function')

_SID = 'gemma-chain'
_EMPTY_THOUGHT = '<|channel>thought\n<channel|>'
_READ_A = '<|tool_call>call:read_workspace_file{path:<|"|>a.txt<|"|>}<tool_call|>'
_READ_B = '<|tool_call>call:read_workspace_file{path:<|"|>b.txt<|"|>}<tool_call|>'


def _chunk(delta: dict | None = None, finish: str | None = None, **extra: Any) -> dict:
    return {
        'choices': [{'finish_reason': finish, 'index': 0, 'delta': delta or {}}],
        'created': 1,
        'id': 'chatcmpl-x',
        'model': 'm',
        'object': 'chat.completion.chunk',
        **extra,
    }


class _Stream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[dict]) -> None:
        self.chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            yield f'data: {json.dumps(chunk)}\n\n'.encode()
        yield b'data: [DONE]\n\n'


class _LlamaServer:
    """Scripted generations for ``/chat/completions``: a ``stop`` match ends one, and the match is not sent."""

    def __init__(self, generations: list[str], *, parses_calls: bool = False, reasoning_field: bool = False) -> None:
        self.generations = list(generations)
        self.parses_calls = parses_calls
        #: The first generation goes out as ``reasoning_content``, as a server that splits thinking sends it.
        self.reasoning_field = reasoning_field
        self.requests: list[dict] = []
        #: What was left of each generation for the client.
        self.kept: list[str] = []

    async def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        text = self.generations.pop(0)
        matches = [text.find(word) for word in body.get('stop') or [] if word in text]
        text = text[: min(matches)] if matches else text
        self.kept.append(text)
        calls = extract_gemma_native_tool_calls(text) if self.parses_calls else []
        if calls:
            text = strip_gemma_native_tool_call_blocks(text)
        field = 'reasoning_content' if self.reasoning_field and len(self.requests) == 1 else 'content'
        chunks = [_chunk({'role': 'assistant', 'content': None}), _chunk({field: text})]
        for index, call in enumerate(calls):
            function = {'name': call['name'], 'arguments': json.dumps(call['args'])}
            delta = {'index': index, 'id': f'api-{index}', 'type': 'function', 'function': function}
            chunks.append(_chunk({'tool_calls': [delta]}))
        chunks.append(_chunk(finish='tool_calls' if calls else 'stop'))
        usage = {'completion_tokens': 5, 'prompt_tokens': 100, 'total_tokens': 105}
        chunks.append({**_chunk(usage=usage), 'choices': []})
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=_Stream(chunks))

    def clients(self, timeout: Any) -> tuple[Any, Any]:
        """Stands in for ``acquire_llm_http_clients``."""
        unused = httpx.MockTransport(lambda _request: httpx.Response(500))
        sync_client = ht._OwnedSyncClient(transport=unused, timeout=timeout)
        async_client = ht._OwnedAsyncClient(
            transport=httpx.MockTransport(self._handle),
            timeout=timeout,
            event_hooks={'request': [ht._on_async_request], 'response': [ht._on_async_response]},
        )
        return sync_client, async_client


def _connection(provider: str = 'llamacpp') -> RuntimeConnection:
    return RuntimeConnection(
        id='p',
        name='p',
        provider=provider,
        base_url='http://mock.invalid/v1',
        model='local-model',
        context_window_tokens=100000,
        optimization_preset='gemma',
    )


@pytest_asyncio.fixture(loop_scope='function')
async def workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> AsyncIterator[Path]:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'cp.sqlite'))
    monkeypatch.setattr(runtime_config, 'connections', [_connection()])
    monkeypatch.setattr(runtime_config, 'active_connection_id', 'p')
    monkeypatch.setattr(runtime_config, 'context_compression', RuntimeContextCompressionConfig())
    monkeypatch.setattr(runtime_config, 'tools', RuntimeToolsConfig())
    await ck.init_graph_checkpointing()
    root = tmp_path / 'ws'
    root.mkdir()
    (root / 'a.txt').write_text('alpha body\n', encoding='utf-8')
    (root / 'b.txt').write_text('beta body\n', encoding='utf-8')
    get_session(_SID).workspace_path = str(root)
    yield root
    await ck.shutdown_graph_checkpointing()


async def _turn(server: _LlamaServer) -> tuple[LangGraphWorkerOutcome, list[dict]]:
    """One user turn: its outcome and the status of each tool row it sent, in order."""
    outcome = LangGraphWorkerOutcome()
    turn = stream_agent_reply(_SID, 'read the files', apply_mode=True, outcome_sink=outcome)
    with patch('clara_coder_backend.llm.factory.acquire_llm_http_clients', server.clients):
        lines = [line async for line in turn]
    payloads = [json.loads(line[6:]) for line in lines if line.startswith('data: {')]
    statuses = [payload['status'] for payload in payloads if payload.get('type') == 'status']
    return outcome, [status for status in statuses if status.get('source') == 'tool']


def _tool_results(body: dict) -> list[tuple[str, str]]:
    return [(message['tool_call_id'], message['content']) for message in body['messages'] if message['role'] == 'tool']


# ---------------------------------------------------------------------------
# Tool calls promoted from the reply's text
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('provider', ['llamacpp', 'lmstudio'])
@pytest.mark.parametrize(
    'reply',
    [
        pytest.param(_READ_A, id='bare'),
        pytest.param(f'<|channel>thought\nNeed the file.<channel|>{_READ_A}', id='after-a-thought'),
    ],
)
async def test_a_native_call_left_in_the_content_runs_its_tool(workspace: Path, provider: str, reply: str) -> None:
    runtime_config.connections[0] = _connection(provider)
    server = _LlamaServer([reply, 'done'])

    outcome, rows = await _turn(server)

    assert outcome.error_detail == ''
    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == 'done'
    assert len(server.requests) == 2
    [(call_id, result)] = _tool_results(server.requests[-1])
    assert call_id == 'gemma-tool-1'
    assert 'alpha body' in result
    # The row the streaming tag opened is the one that reports the run.
    assert rows[0]['id'] == rows[-1]['id']
    assert rows[-1]['state'] == 'complete'
    assert not any(row['state'] == 'error' for row in rows)


async def test_a_native_call_only_in_the_reasoning_field_runs_its_tool(workspace: Path) -> None:
    """The content is empty, so without looking at the sidecar this reads as an empty reply and is drawn again."""
    server = _LlamaServer([_READ_A, 'done'], reasoning_field=True)

    outcome, _rows = await _turn(server)

    assert outcome.error_detail == ''
    assert outcome.final_text == 'done'
    assert len(server.requests) == 2
    [(_call_id, result)] = _tool_results(server.requests[-1])
    assert 'alpha body' in result


async def test_parallel_native_calls_run_and_their_ids_may_come_back(workspace: Path) -> None:
    server = _LlamaServer([_READ_A + _READ_B, _READ_B, 'done'])

    outcome, _rows = await _turn(server)

    assert outcome.state == AgentLoopOutcome.COMPLETED
    assert outcome.final_text == 'done'
    results = _tool_results(server.requests[-1])
    assert [call_id for call_id, _result in results] == ['gemma-tool-1', 'gemma-tool-2', 'gemma-tool-1']
    assert ['alpha' in result for _call_id, result in results] == [True, False, False]
    assert ['beta' in result for _call_id, result in results] == [False, True, True]


# ---------------------------------------------------------------------------
# The stop sequence for the empty thought loop
# ---------------------------------------------------------------------------


async def test_a_thought_reopened_ahead_of_a_tool_call_is_not_cut(workspace: Path) -> None:
    """Common replies, and the server must let them through to the call instead of ending them after the thought."""
    first = f'<|channel>thought\nI will read a.txt.<channel|>{_EMPTY_THOUGHT}{_READ_A}'
    # After a tool result the prompt opened the thought: the reply closes it first.
    second = f'<channel|>{_EMPTY_THOUGHT}{_READ_B}'
    server = _LlamaServer([first, second, 'done'], parses_calls=True)

    outcome, _rows = await _turn(server)

    assert outcome.final_text == 'done'
    assert len(server.requests) == 3
    results = [result for _call_id, result in _tool_results(server.requests[-1])]
    assert len(results) == 2
    assert 'alpha body' in results[0]
    assert 'beta body' in results[1]


@pytest.mark.parametrize(
    'before',
    [
        pytest.param('', id='from-the-start'),
        pytest.param('<|channel>thought\nA thought.<channel|>', id='after-a-thought'),
    ],
)
async def test_the_empty_thought_loop_is_cut_and_drawn_again(workspace: Path, before: str) -> None:
    server = _LlamaServer([before + _EMPTY_THOUGHT * 5569, 'done'])

    outcome, _rows = await _turn(server)

    assert server.kept[0] == before
    assert outcome.final_text == 'done'
    assert len(server.requests) == 2
    assert server.requests[1]['messages'] == server.requests[0]['messages']
