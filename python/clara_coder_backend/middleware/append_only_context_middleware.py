"""Keep a Claude thread append-only: the system prompt and tools it started with, changes as appended messages.

Claude's preserved thinking binds each thinking block to the system prompt, the tool definitions and every
message before it. A thread that re-renders its system prompt (a re-frozen workspace tree, another model in
the connection line, a speech setting, the managed workspace text) or offers another tool set (an MCP server
connected, a sub-agent tool) on a later call would invalidate every earlier block, and after a restart every
graph renders both again.

So the first model call on a thread stores what it sent in the checkpoint, and every later Claude call sends
those same bytes. What changed since goes out once, as a mid-conversation ``role: "system"`` message saved
in the thread ahead of the reply it produced:

- the system prompt: the sections that are new or changed, and the ones that no longer apply;
- tools: ``tool_addition`` by value for a new tool or a changed definition (by reference to re-offer one),
  ``tool_removal`` by reference for one that went away (its definition stays in ``tools``; a call to it gets
  the tool node's ordinary "not a valid tool" error).

The message is a HumanMessage whose ``additional_kwargs`` carry the blocks (see
:data:`~clara_coder_backend.llm.anthropic_llm.SYSTEM_BLOCKS_KEY`); its text is what another provider sees if
the conversation moves to one. Other providers, and Claude models without mid-conversation system messages,
get the current prompt and tools as before.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from langchain.agents.middleware import AgentMiddleware
from langchain_anthropic.chat_models import convert_to_anthropic_tool
from langchain.agents.middleware.types import (
    AgentState,
    ExtendedModelResponse,
    PrivateStateAttr,
    ResponseT,
)
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langgraph.types import Command
from typing_extensions import NotRequired, override

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.llm.anthropic_llm import (
    SYSTEM_BLOCKS_KEY,
    is_compaction_summary,
    supports_mid_conversation_system,
)
from clara_coder_backend.middleware.user_event_injection_middleware import with_messages_before
from clara_coder_backend.session.state import get_active_connection

logger = logging.getLogger('clara.middleware.append_only')

STATE_KEY = 'append_only_context'
_SYSTEM_CHANGE_LEAD = (
    'Your system instructions changed during this conversation. The system prompt above is the version this '
    'conversation started with; where it differs from this update, follow this update.'
)
_REMOVED_SECTION_PREVIEW_CHARS = 160


class _AppendOnlyState(AgentState[ResponseT]):
    """``{system, announced, tools, in_effect, withdrawn, compaction_id}``: what the first call sent, what changed since."""

    append_only_context: NotRequired[Annotated[dict[str, Any], PrivateStateAttr]]


def append_only_active(connection: RuntimeConnection | None) -> bool:
    """Claude on a model that takes mid-conversation system messages (every model with preserved thinking)."""
    return (
        connection is not None
        and connection.provider == 'anthropic'
        and supports_mid_conversation_system(connection.model or '')
    )


def _system_text(message: BaseMessage | None) -> str:
    if message is None:
        return ''
    content = message.content
    if isinstance(content, str):
        return content
    return ''.join(
        str(part.get('text') or '') if isinstance(part, dict) else str(part) for part in content
    )


def _tool_definitions(tools: list[Any]) -> list[dict[str, Any]]:
    return [dict(convert_to_anthropic_tool(tool)) for tool in tools]


def _sections(text: str) -> list[str]:
    return [section.strip() for section in text.split('\n\n') if section.strip()]


def system_change_text(before: str, after: str) -> str:
    """The update for a system prompt that went from ``before`` to ``after``: new sections whole, gone ones named."""
    old = _sections(before)
    new = _sections(after)
    old_set, new_set = set(old), set(new)
    added = [section for section in new if section not in old_set]
    removed = [section for section in old if section not in new_set]
    parts = [_SYSTEM_CHANGE_LEAD]
    if added:
        parts.append('New or updated sections, in effect from now on:\n\n' + '\n\n'.join(added))
    if removed:
        names = '\n'.join(
            f'- {section.splitlines()[0][:_REMOVED_SECTION_PREVIEW_CHARS]}' for section in removed
        )
        parts.append(f'Sections that no longer apply (replaced by the update above, or gone):\n{names}')
    return '\n\n'.join(parts)


def _tool_changes(
    saved: dict[str, Any], current: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """``(blocks, added names, removed names)`` taking ``saved`` to ``current``; updates ``saved`` in place."""
    in_effect: dict[str, Any] = dict(saved.get('in_effect') or {})
    withdrawn: list[str] = list(saved.get('withdrawn') or [])
    blocks: list[dict[str, Any]] = []
    added: list[str] = []
    removed: list[str] = []
    current_names = set()
    for definition in current:
        name = str(definition.get('name') or '')
        current_names.add(name)
        if name in withdrawn:
            withdrawn.remove(name)
            if in_effect.get(name) == definition:
                blocks.append({'type': 'tool_addition', 'tool': {'type': 'tool_reference', 'name': name}})
                added.append(name)
                continue
        elif in_effect.get(name) == definition:
            continue
        blocks.append({'type': 'tool_addition', 'tool': {'type': 'tool_definition', 'definition': definition}})
        in_effect[name] = definition
        added.append(name)
    for name in in_effect:
        if name not in current_names and name not in withdrawn:
            blocks.append({'type': 'tool_removal', 'tool': {'type': 'tool_reference', 'name': name}})
            withdrawn.append(name)
            removed.append(name)
    saved['in_effect'] = in_effect
    saved['withdrawn'] = withdrawn
    return blocks, added, removed


def last_compaction(messages: list[Any]) -> tuple[str, bool]:
    """``(id, records tool changes)`` of the newest assistant message with a compaction summary, or ``('', False)``.

    A block without a summary replaced nothing, so the notices before it still stand.
    """
    for message in reversed(messages):
        content = getattr(message, 'content', None)
        if isinstance(message, AIMessage) and isinstance(content, list):
            for block in content:
                if is_compaction_summary(block):
                    return str(message.id or ''), 'tool_changes' in block
    return '', False


def change_notice(system_update: str, tool_blocks: list[dict[str, Any]], added: list[str], removed: list[str]) -> HumanMessage:
    """The appended message: ``role: "system"`` blocks for Claude, the same news as text for anyone else."""
    blocks: list[dict[str, Any]] = []
    lines: list[str] = []
    if system_update:
        blocks.append({'type': 'text', 'text': system_update})
        lines.append(system_update)
    if added:
        lines.append('Tools now available: ' + ', '.join(sorted(added)) + '.')
    if removed:
        lines.append('Tools no longer available: ' + ', '.join(sorted(removed)) + '.')
    blocks.extend(tool_blocks)
    return HumanMessage(content='\n\n'.join(lines), additional_kwargs={SYSTEM_BLOCKS_KEY: blocks})


class AppendOnlyContextMiddleware(AgentMiddleware):
    """Send a Claude thread's first system prompt and tools on every call; announce changes by appending."""

    state_schema = _AppendOnlyState  # type: ignore[assignment]

    @override
    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        try:
            connection = get_active_connection()
        except Exception:
            connection = None
        if not append_only_active(connection):
            return await handler(request)
        state = request.state if isinstance(request.state, dict) else {}
        saved = dict(state.get(STATE_KEY) or {})
        current_system = _system_text(request.system_message)
        current_tools = _tool_definitions(list(request.tools or []))
        if not saved:
            saved = {
                'system': current_system,
                'announced': current_system,
                'tools': current_tools,
                'in_effect': {str(tool.get('name') or ''): tool for tool in current_tools},
                'withdrawn': [],
            }
            response = await handler(request.override(tools=current_tools))
            return ExtendedModelResponse(model_response=response, command=Command(update={STATE_KEY: saved}))

        compaction_id, carries_tools = last_compaction(request.messages)
        if compaction_id and compaction_id != saved.get('compaction_id'):
            # Claude compacted: the summary replaced every earlier message, the system notices among them. The
            # thread still has its first system prompt, so the difference is announced again. Tool changes carry
            # over when the block records them (``tool_changes``); without that, tools are back to the first set.
            saved['compaction_id'] = compaction_id
            saved['announced'] = saved.get('system') or ''
            first = {str(tool.get('name') or ''): tool for tool in saved.get('tools') or []}
            if not carries_tools:
                saved['in_effect'] = first
                saved['withdrawn'] = []
            else:
                # The block records the tools in effect at its end. A withdrawn tool that a message defined is
                # in neither the block nor ``tools`` now, so a reference to it would not resolve (a 400 on
                # every retry): forget it, and offering it again defines it again.
                withdrawn = [name for name in saved.get('withdrawn') or [] if name in first]
                gone = set(saved.get('withdrawn') or []) - set(withdrawn)
                saved['withdrawn'] = withdrawn
                saved['in_effect'] = {
                    name: tool for name, tool in (saved.get('in_effect') or {}).items() if name not in gone
                }
        system_update = ''
        if current_system != saved.get('announced'):
            system_update = system_change_text(str(saved.get('announced') or ''), current_system)
            saved['announced'] = current_system
        tool_blocks, added, removed = _tool_changes(saved, current_tools)
        frozen = request.override(
            system_message=SystemMessage(content=str(saved.get('system') or '')),
            tools=list(saved.get('tools') or []),
        )
        if not system_update and not tool_blocks:
            return await handler(frozen)
        notice = change_notice(system_update, tool_blocks, added, removed)
        if system_update:
            logger.debug('System prompt update for this thread: %.2000s', system_update)
        logger.info(
            'Thread context changed: system prompt %s, tools added %s, removed %s',
            'updated' if system_update else 'unchanged',
            added,
            removed,
        )
        response = await handler(frozen.override(messages=[*frozen.messages, notice]))
        return ExtendedModelResponse(
            model_response=with_messages_before(response, [notice]),
            command=Command(update={STATE_KEY: saved}),
        )


__all__ = ['AppendOnlyContextMiddleware', 'append_only_active', 'change_notice', 'system_change_text']
