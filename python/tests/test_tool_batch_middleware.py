"""Tests for tagging tool calls with the model message (batch) that issued them."""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.prebuilt.tool_node import ToolCallRequest

from clara_coder_backend.middleware.tool_batch_middleware import ToolBatchMiddleware, tool_batch_id
from clara_coder_backend.session.state import current_tool_batch_id


def _call(call_id: str) -> dict:
    return {'name': 'probe', 'id': call_id, 'args': {}}


def test_parallel_calls_share_their_message_id() -> None:
    earlier = AIMessage(content='', id='m1', tool_calls=[_call('a')])
    batch = AIMessage(content='', id='m2', tool_calls=[_call('b'), _call('c')])
    messages = [HumanMessage(content='hi'), earlier, ToolMessage(content='ok', tool_call_id='a'), batch]

    assert tool_batch_id(_call('b'), messages) == 'm2'
    assert tool_batch_id(_call('c'), messages) == 'm2'
    assert tool_batch_id(_call('a'), messages) == 'm1'


def test_unknown_or_missing_call_id_has_no_batch() -> None:
    messages = [AIMessage(content='', id='m1', tool_calls=[_call('a')])]

    assert tool_batch_id(_call('zzz'), messages) == ''
    assert tool_batch_id({'name': 'probe', 'args': {}}, messages) == ''
    assert tool_batch_id(_call('a'), None) == ''


def test_message_without_id_falls_back_to_a_per_message_key() -> None:
    first = AIMessage(content='', tool_calls=[_call('call_0')])
    second = AIMessage(content='', tool_calls=[_call('call_1')])

    a = tool_batch_id(_call('call_0'), [first, second])
    b = tool_batch_id(_call('call_1'), [first, second])

    assert a and b and a != b


@tool('probe')
def _probe() -> str:
    """Report the batch id a sync tool sees from its executor thread."""
    return current_tool_batch_id.get()


@pytest.mark.asyncio(loop_scope='function')
async def test_sync_tool_sees_the_batch_id_and_it_is_cleared_after() -> None:
    batch = AIMessage(content='', id='m9', tool_calls=[_call('x')])
    req = ToolCallRequest(
        tool_call=_call('x'),
        tool=_probe,
        state={'messages': [batch]},  # type: ignore[arg-type]
        runtime=None,  # type: ignore[arg-type]
    )

    async def handler(r: ToolCallRequest) -> ToolMessage:
        return ToolMessage(content=await _probe.ainvoke({}), tool_call_id=r.tool_call['id'])

    out = await ToolBatchMiddleware().awrap_tool_call(req, handler)

    assert out.content == 'm9'
    assert current_tool_batch_id.get() == ''
