"""Repair of tool calls an interrupted turn left unanswered (``lang_agent.interrupt_repair``)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from clara_coder_backend.lang_agent.interrupt_repair import (
    INTERRUPTED_TOOL_RESULT,
    NOT_APPROVED_TOOL_RESULT,
    repair_interrupted_tool_calls,
)


def _call(call_id: str, name: str = 'read_workspace_file') -> dict[str, Any]:
    return {'name': name, 'args': {}, 'id': call_id}


def _step(*call_ids: str, name: str = 'read_workspace_file') -> AIMessage:
    return AIMessage(content='', tool_calls=[_call(c, name) for c in call_ids])


def _result(call_id: str, text: str = 'ok', name: str = 'read_workspace_file') -> ToolMessage:
    return ToolMessage(content=text, tool_call_id=call_id, name=name)


def _write(*messages: Any) -> tuple[str, str, list[Any]]:
    return ('task-1', 'messages', list(messages))


# ---------------------------------------------------------------------------
# Pure
# ---------------------------------------------------------------------------


def test_nothing_to_repair() -> None:
    assert repair_interrupted_tool_calls([], [], {}) == []
    assert repair_interrupted_tool_calls([HumanMessage('hi'), AIMessage('hello')], [], {}) == []
    answered = [HumanMessage('hi'), _step('a', 'b'), _result('a'), _result('b'), AIMessage('done')]
    assert repair_interrupted_tool_calls(answered, [], {}) == []


def test_finished_calls_are_recovered_and_hung_ones_get_an_interrupted_result() -> None:
    messages = [HumanMessage('go'), _step('a', 'b', 'c'), _result('a', 'checkpointed')]
    writes = [
        _write(_result('b', 'recovered b')),
        ('task-2', '__error__', 'CancelledError()'),
        ('task-1', 'branch:to:model', None),
    ]

    out = repair_interrupted_tool_calls(messages, writes, {})

    assert [m.tool_call_id for m in out] == ['b', 'c']
    assert out[0].content == 'recovered b'
    assert out[1].content == INTERRUPTED_TOOL_RESULT and out[1].status == 'error'
    assert out[1].name == 'read_workspace_file'


def test_a_call_still_waiting_for_approval_is_not_approved() -> None:
    pending = 'Pending user confirmation for `run_command`. The UI will ask the user to confirm before this command runs.'
    answered = f'{pending}\n\n---\nCommand report: exited 0'
    messages = [_step('a', 'b', 'c', name='run_command')]
    writes = [
        _write(_result('a', pending, 'run_command')),
        _write(_result('b', answered, 'run_command')),
        # A delete review answer rides along as a HumanMessage in the same write.
        _write(_result('c', 'Pending user confirmation: big/ is too large', 'run_command'), HumanMessage('User confirmed.')),
    ]

    out = {m.tool_call_id: m for m in repair_interrupted_tool_calls(messages, writes, {})}

    assert out['a'].content == NOT_APPROVED_TOOL_RESULT and out['a'].status == 'error'
    assert out['b'].content == answered
    assert out['c'].content.endswith('---\nUser confirmed.')


def test_a_stopped_subagent_call_gets_its_stashed_report() -> None:
    messages = [_step('s1', 's2', name='spawn_subagent')]
    out = repair_interrupted_tool_calls(messages, [], {'s1': 'Sub-agent `x` was stopped… partial'})

    assert out[0].tool_call_id == 's1' and out[0].content.startswith('Sub-agent `x` was stopped')
    assert out[0].status == 'success'
    assert out[1].content == INTERRUPTED_TOOL_RESULT


def test_a_gap_in_an_earlier_step_rebuilds_the_whole_list() -> None:
    old = _step('x', 'y')
    messages = [HumanMessage('one'), old, _result('x'), AIMessage('reply'), HumanMessage('two'), _step('z')]

    out = repair_interrupted_tool_calls(messages, [_write(_result('z', 'z done'))], {})

    assert isinstance(out[0], RemoveMessage) and out[0].id == REMOVE_ALL_MESSAGES
    rebuilt = out[1:]
    shape = [(m.type, getattr(m, 'tool_call_id', None)) for m in rebuilt]
    assert shape == [
        ('human', None),
        ('ai', None),
        ('tool', 'x'),
        ('tool', 'y'),
        ('ai', None),
        ('human', None),
        ('ai', None),
        ('tool', 'z'),
    ]
    assert rebuilt[3].content == INTERRUPTED_TOOL_RESULT
    assert rebuilt[7].content == 'z done'


def test_a_gap_followed_by_other_messages_is_rebuilt_in_place() -> None:
    messages = [_step('a', 'b'), _result('a'), HumanMessage('a later input')]

    out = repair_interrupted_tool_calls(messages, [], {})

    assert isinstance(out[0], RemoveMessage)
    assert [(m.type, getattr(m, 'tool_call_id', None)) for m in out[1:]] == [
        ('ai', None),
        ('tool', 'a'),
        ('tool', 'b'),
        ('human', None),
    ]


# ---------------------------------------------------------------------------
# Real checkpointer: what LangGraph keeps from a cancelled parallel tool step
# ---------------------------------------------------------------------------


class _ToolCallingFake(GenericFakeChatModel):
    seen: list[list[Any]] = []

    def bind_tools(self, tools: Any, **_kwargs: Any) -> _ToolCallingFake:
        return self

    def _generate(self, messages: list[Any], *args: Any, **kwargs: Any) -> Any:
        self.seen.append(list(messages))
        return super()._generate(messages, *args, **kwargs)


@tool
async def fast(x: str) -> str:
    """Return at once."""
    return f'fast:{x}'


@tool
async def slow(x: str) -> str:
    """Never return."""
    await asyncio.Future()
    return 'never'


@pytest.mark.asyncio(loop_scope='function')
async def test_repair_against_a_real_checkpoint_after_a_cancelled_parallel_step(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv('CLARA_CHECKPOINT_DB', str(tmp_path / 'repair.sqlite'))
    from clara_coder_backend.session.checkpointing import (
        get_graph_checkpointer,
        init_graph_checkpointing,
        shutdown_graph_checkpointing,
    )

    await init_graph_checkpointing()
    try:
        model = _ToolCallingFake(
            messages=iter(
                [
                    AIMessage(content='', tool_calls=[_call('c1', 'fast') | {'args': {'x': '1'}}, _call('c2', 'slow') | {'args': {'x': '2'}}]),
                    AIMessage(content='after the interrupt'),
                ]
            ),
            disable_streaming=True,
        )
        graph = create_agent(model, [fast, slow], system_prompt='sys', checkpointer=get_graph_checkpointer())
        config = {'configurable': {'thread_id': 'repair-t1'}}
        fast_done = asyncio.Event()

        async def run() -> None:
            async for ev in graph.astream_events(
                {'messages': [HumanMessage('hi')]}, config, version='v2', durability='sync'
            ):
                if ev['event'] == 'on_tool_end' and ev['name'] == 'fast':
                    fast_done.set()

        pump = asyncio.create_task(run())
        await asyncio.wait_for(fast_done.wait(), timeout=5)
        await asyncio.sleep(0.1)
        pump.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pump

        saved = await get_graph_checkpointer().aget_tuple(config)
        channel = saved.checkpoint['channel_values']['messages']
        # The finished call's result is only a pending write: the next run would drop it.
        assert [m.type for m in channel] == ['human', 'ai']
        repairs = repair_interrupted_tool_calls(channel, saved.pending_writes, {})
        assert [(m.tool_call_id, m.content) for m in repairs] == [('c1', 'fast:1'), ('c2', INTERRUPTED_TOOL_RESULT)]

        out = await graph.ainvoke({'messages': [*repairs, HumanMessage('next')]}, config)

        seen = [(m.type, getattr(m, 'tool_call_id', None)) for m in model.seen[-1]]
        assert seen == [('system', None), ('human', None), ('ai', None), ('tool', 'c1'), ('tool', 'c2'), ('human', None)]
        assert out['messages'][-1].content == 'after the interrupt'
    finally:
        await shutdown_graph_checkpointing()
