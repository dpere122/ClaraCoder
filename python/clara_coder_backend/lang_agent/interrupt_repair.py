"""Answer the tool calls an interrupted turn left without a result, before the next turn's input.

A stopped or interrupted agent turn keeps its checkpoint, but the model step that requested tools may
have ended before every call returned. LangGraph treats new input on that thread as a fresh run from
``START``: it drops the unfinished calls and also the results of the calls that did finish (those sit
in the checkpoint's pending writes, one ``Send`` task per call). The next model request would then
carry an ``AIMessage`` whose ``tool_calls`` have no ``ToolMessage``, which OpenAI-compatible servers
reject.

:func:`repair_interrupted_tool_calls` builds the messages that go in front of the next input so every
call has exactly one result: the recovered result when the call finished, a stashed note for a
spawn call whose sub-agent outlived the turn, or a short "interrupted" error. It is pure; the graph runner
reads the checkpoint.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, RemoveMessage, ToolMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from clara_coder_backend.llm.messages import stringify_content
from clara_coder_backend.session.pause import PENDING_APPROVAL_PREFIX

#: Result for a call that was still running when the user stopped the turn.
INTERRUPTED_TOOL_RESULT = (
    'Interrupted: the user stopped this turn before this call finished; no result. '
    'Side effects already made remain.'
)

#: Result for a call whose approval card was still open when the user stopped the turn.
NOT_APPROVED_TOOL_RESULT = (
    'Not approved: the user stopped this turn while this call waited for approval, so it did not run.'
)

#: How review middlewares append the answer to a staged call's result (see accept-command review).
_ANSWER_SEPARATOR = '\n\n---\n'


def _call_id(call: Mapping[str, Any]) -> str:
    return str(call.get('id') or '')


def _recovered_results(pending_writes: Iterable[Any]) -> dict[str, ToolMessage]:
    """ToolMessages that finished calls wrote but no checkpoint applied, by tool call id.

    Pending writes are ``(task_id, channel, value)``; a tool task writes ``[ToolMessage]`` (or one
    message) to the ``messages`` channel. A delete review answer rides along as a HumanMessage in the
    same write; it is folded into the result, since nothing may sit between a step's results.
    Errors and routing writes are ignored.
    """
    out: dict[str, ToolMessage] = {}
    for write in pending_writes or ():
        if not isinstance(write, (tuple, list)) or len(write) < 3 or write[1] != 'messages':
            continue
        value = write[2]
        items = list(value) if isinstance(value, (list, tuple)) else [value]
        results = [m for m in items if isinstance(m, ToolMessage) and m.tool_call_id]
        notes = [stringify_content(m.content).strip() for m in items if isinstance(m, HumanMessage)]
        notes = [n for n in notes if n]
        for result in results:
            if notes and len(results) == 1:
                body = stringify_content(result.content).strip()
                result = result.model_copy(update={'content': _ANSWER_SEPARATOR.join([body, *notes])})
            out.setdefault(str(result.tool_call_id), result)
    return out


def _awaiting_approval(message: ToolMessage) -> bool:
    """True for a staged call's bare "Pending user confirmation" result that no answer was added to."""
    text = stringify_content(message.content)
    return text.startswith(PENDING_APPROVAL_PREFIX) and _ANSWER_SEPARATOR.strip() not in text


def _result_for(
    call: Mapping[str, Any],
    recovered: Mapping[str, ToolMessage],
    reports: Mapping[str, str],
) -> ToolMessage:
    """First that applies: the recovered result, the stashed note, a synthetic interrupted error."""
    call_id = _call_id(call)
    name = str(call.get('name') or '') or None
    found = recovered.get(call_id)
    if found is not None:
        if not _awaiting_approval(found):
            return found
        return ToolMessage(content=NOT_APPROVED_TOOL_RESULT, tool_call_id=call_id, name=name, status='error')
    report = reports.get(call_id)
    if report:
        return ToolMessage(content=report, tool_call_id=call_id, name=name)
    return ToolMessage(content=INTERRUPTED_TOOL_RESULT, tool_call_id=call_id, name=name, status='error')


def _results_after(messages: Sequence[BaseMessage], index: int) -> tuple[set[str], int]:
    """Call ids answered by the ToolMessages right after ``messages[index]``, and where they end."""
    answered: set[str] = set()
    end = index + 1
    while end < len(messages) and isinstance(messages[end], ToolMessage):
        answered.add(str(messages[end].tool_call_id or ''))
        end += 1
    return answered, end


def repair_interrupted_tool_calls(
    messages: Sequence[BaseMessage],
    pending_writes: Iterable[Any],
    overrides: Mapping[str, str] | None = None,
) -> list[BaseMessage]:
    """Messages to put before the next turn's input so no tool call is left without a result.

    ``messages`` is the checkpoint's ``messages`` channel, not :meth:`aget_state` values (those already
    fold in pending writes, which the next run discards). ``overrides`` maps a call id to the result to
    use when nothing was recovered (a spawn call whose sub-agent keeps running: where its report comes from).

    The usual gap is in the last tool step, with only results after it: the missing results are
    returned to be appended. Any other gap (an earlier step, or other messages after the step) returns
    the whole list rebuilt behind ``RemoveMessage(REMOVE_ALL_MESSAGES)``. ``[]`` when nothing is missing.
    """
    msgs = list(messages or [])
    gaps: list[tuple[int, list[dict[str, Any]]]] = []
    for index, message in enumerate(msgs):
        if isinstance(message, AIMessage) and message.tool_calls:
            answered, _end = _results_after(msgs, index)
            missing = [call for call in message.tool_calls if _call_id(call) not in answered]
            if missing:
                gaps.append((index, missing))
    if not gaps:
        return []

    recovered = _recovered_results(pending_writes)
    reports = dict(overrides or {})
    index, missing = gaps[-1]
    if len(gaps) == 1 and _results_after(msgs, index)[1] == len(msgs):
        return [_result_for(call, recovered, reports) for call in missing]

    missing_at = dict(gaps)
    fixed: list[BaseMessage] = []
    index = 0
    while index < len(msgs):
        fixed.append(msgs[index])
        if index not in missing_at:
            index += 1
            continue
        _answered, end = _results_after(msgs, index)
        fixed.extend(msgs[index + 1 : end])
        fixed.extend(_result_for(call, recovered, reports) for call in missing_at[index])
        index = end
    return [RemoveMessage(id=REMOVE_ALL_MESSAGES), *fixed]


__all__ = [
    'INTERRUPTED_TOOL_RESULT',
    'NOT_APPROVED_TOOL_RESULT',
    'repair_interrupted_tool_calls',
]
