"""Construct a LangChain ``ChatAnthropic`` client for the Claude source.

``ChatAnthropic`` (``langchain-anthropic``) calls the Messages API through the official
``anthropic`` SDK. Request shape, per the active model's Models API capabilities (Electron
sends them as ``chat_template_reasoning``):

- Adaptive thinking with summarized display when the model supports it, so reasoning streams
  into the reasoning panel; effort is the only depth control (current models cannot turn
  thinking off). ``disable_thinking`` one-shot calls drop to ``low`` effort instead.
- Preserved thinking: a thinking block is bound to the system prompt, the tools and every message
  before it, so a Claude thread only ever grows (see :mod:`~clara_coder_backend.middleware.append_only_context_middleware`).
  ``thinking.block_binding.prefix_mismatch_behavior = "drop_block"`` stays as the safety net: an edit
  that still slips through (a ClaraCoder compaction after an overflow, a provider switch) costs that
  reasoning instead of failing the request with a 400. Every dropped block is logged from the
  response's ``input_transformations``.
- Mid-conversation ``role: "system"`` messages: a HumanMessage whose ``additional_kwargs`` hold
  :data:`SYSTEM_BLOCKS_KEY` goes out as a system message with those blocks (its own text is what other
  providers see). That is how a changed system prompt or tool list reaches a running thread.
- Server-side compaction (``compact_20260112``) when the compaction middleware asks for it; the
  ``compaction`` blocks come back in the assistant content and are sent back as received.
- Top-level automatic prompt caching (``cache_control``), so the system prompt and tool list are
  billed at cache rates on every agent step after the first.
- No sampling parameters (current Claude models reject them).
"""

from __future__ import annotations

import logging
import os
from functools import cached_property
from typing import Any

import anthropic
from fastapi import HTTPException
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessageChunk, BaseMessage, HumanMessage

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.llm.http_transport import acquire_anthropic_http_clients
from clara_coder_backend.llm.model_tuning import llm_optional_kwargs
from clara_coder_backend.logging.llm_interaction_logging import log_llm_connection_settings
from clara_coder_backend.session.state import require_openai_api_key

logger = logging.getLogger('clara.llm.anthropic')

# Streaming keeps a large cap safe from HTTP timeouts; Settings' max output (when set) wins.
ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 64_000
# Lets the request set ``thinking.block_binding`` (drop invalidated thinking blocks, not 400).
THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01'
# Threshold (server-side) compaction: the ``compact_20260112`` context-management edit.
COMPACTION_BETA = 'compact-2026-01-12'
COMPACTION_EDIT_TYPE = 'compact_20260112'
# ``tool_addition`` / ``tool_removal`` blocks in a system message, by reference or by value.
INLINE_TOOLS_BETA = 'inline-tools-2026-09-15'
#: HumanMessage ``additional_kwargs`` key: the content blocks of a mid-conversation system message.
SYSTEM_BLOCKS_KEY = 'clara_system_blocks'
_SYSTEM_MARKER_TYPE = '_clara_system_message'
_TOOL_CHANGE_TYPES = frozenset({'tool_addition', 'tool_removal'})
# A streamed compaction block carries LangChain's ``index`` (and, after a signature delta, its empty
# ``thinking``); everything else goes back exactly as it came.
_COMPACTION_BLOCK_KEYS = ('type', 'content', 'encrypted_content', 'signature', 'tool_changes', 'cache_control')
#: Models that take mid-conversation system messages (the Mid-conversation system messages page).
#: Every model with preserved thinking is among them; Claude Sonnet 5 is not.
_MID_CONVERSATION_SYSTEM_PREFIXES = (
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-opus-4-8',
)


def supports_mid_conversation_system(model: str) -> bool:
    """True when ``model`` accepts ``role: "system"`` messages after the first user turn."""
    name = (model or '').strip().lower()
    return name.startswith(_MID_CONVERSATION_SYSTEM_PREFIXES)


def _as_marked_message(message: BaseMessage) -> BaseMessage:
    """A system-notice HumanMessage as one marker block that survives LangChain's formatting untouched."""
    if not isinstance(message, HumanMessage):
        return message
    blocks = (message.additional_kwargs or {}).get(SYSTEM_BLOCKS_KEY)
    if not blocks:
        return message
    return HumanMessage(content=[{'type': _SYSTEM_MARKER_TYPE, 'blocks': list(blocks)}])


def place_system_messages(formatted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Turn marker blocks into ``role: "system"`` messages, each right before the next assistant turn.

    The API wants a system message after a user message and before an assistant message (or last), so
    the markers of one user turn go out together after that turn's other blocks. The result depends only
    on the history, so the same history always renders the same bytes.
    """
    out: list[dict[str, Any]] = []
    pending: list[Any] = []
    for message in formatted:
        content = message.get('content')
        if message.get('role') == 'user' and isinstance(content, list):
            kept = [b for b in content if not (isinstance(b, dict) and b.get('type') == _SYSTEM_MARKER_TYPE)]
            for block in content:
                if isinstance(block, dict) and block.get('type') == _SYSTEM_MARKER_TYPE:
                    pending.extend(block.get('blocks') or [])
            if kept:
                out.append({**message, 'content': kept} if len(kept) != len(content) else message)
            continue
        if message.get('role') == 'assistant' and pending:
            out.append({'role': 'system', 'content': pending})
            pending = []
        out.append(message)
    if pending:
        out.append({'role': 'system', 'content': pending})
    return out


def _clean_compaction_blocks(formatted: list[dict[str, Any]]) -> None:
    for message in formatted:
        content = message.get('content')
        if message.get('role') != 'assistant' or not isinstance(content, list):
            continue
        for index, block in enumerate(content):
            if isinstance(block, dict) and block.get('type') == 'compaction':
                content[index] = {key: block[key] for key in _COMPACTION_BLOCK_KEYS if key in block}


def from_last_compaction(formatted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The messages from the newest compaction block on: the API drops everything before it anyway.

    The block opens its assistant message, so the request starts with it. Without this the body would keep
    every message the thread ever had, compacted or not.
    """
    for index in range(len(formatted) - 1, 0, -1):
        message = formatted[index]
        content = message.get('content')
        if message.get('role') == 'assistant' and isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict) and first.get('type') == 'compaction':
                return formatted[index:]
    return formatted


def _compaction_start_fields(start_event: Any) -> dict[str, Any]:
    """What a compaction block's ``content_block_start`` carries besides the summary: ``signature``, ``tool_changes``.

    LangChain builds the block from the delta alone, so these would be lost; the API wants them back unchanged
    (a block without its ``tool_changes`` invalidates the thinking produced after it).
    """
    block = getattr(start_event, 'content_block', None)
    if block is None or getattr(block, 'type', None) != 'compaction':
        return {}
    fields = block.model_dump(mode='json', exclude_unset=True) if hasattr(block, 'model_dump') else {}
    return {key: value for key, value in fields.items() if key not in ('type', 'content') and value is not None}


def _carries_tool_changes(formatted: list[dict[str, Any]]) -> bool:
    return any(
        isinstance(block, dict) and block.get('type') == 'compaction' and 'tool_changes' in block
        for message in formatted
        if isinstance(message.get('content'), list)
        for block in message['content']
    )


def _uses_server_compaction(payload: dict[str, Any]) -> bool:
    edits = (payload.get('context_management') or {}).get('edits') or []
    return any(isinstance(edit, dict) and edit.get('type') == COMPACTION_EDIT_TYPE for edit in edits)


def _has_tool_changes(formatted: list[dict[str, Any]]) -> bool:
    return any(
        isinstance(block, dict) and block.get('type') in _TOOL_CHANGE_TYPES
        for message in formatted
        if message.get('role') == 'system' and isinstance(message.get('content'), list)
        for block in message['content']
    )


def _count_blocks(formatted: list[dict[str, Any]], kind: str) -> int:
    return sum(
        isinstance(block, dict) and block.get('type') == kind
        for message in formatted
        if isinstance(message.get('content'), list)
        for block in message['content']
    )


def _with_beta(betas: list[str], beta: str) -> list[str]:
    return betas if beta in betas else [*betas, beta]


def input_transformations(message: Any) -> list[dict[str, Any]] | None:
    """The response's ``input_transformations`` (present with the binding beta), as plain dicts."""
    raw = getattr(message, 'input_transformations', None)
    if raw is None:
        raw = (getattr(message, 'model_extra', None) or {}).get('input_transformations')
    if raw is None:
        return None
    return [entry.model_dump() if hasattr(entry, 'model_dump') else dict(entry) for entry in raw]


def log_input_transformations(entries: list[dict[str, Any]], model: str) -> None:
    """Log what the API left out of a request: a prefix mismatch is a history edit to find and fix."""
    if not entries:
        return
    by_reason: dict[str, list[str]] = {}
    for entry in entries:
        by_reason.setdefault(str(entry.get('reason') or entry.get('type') or 'unknown'), []).append(str(entry.get('path') or ''))
    for reason, paths in by_reason.items():
        level = logging.WARNING if reason == 'prefix_binding_mismatch' else logging.INFO
        logger.log(level, 'Claude (%s) left out %d thinking block(s), reason %s: %s', model, len(paths), reason, ', '.join(paths[:8]))


class ClaraChatAnthropic(ChatAnthropic):
    """``ChatAnthropic`` on Clara's owned ``httpx2`` clients, so Stop can close the live stream.

    Also shapes the payload for an append-only thread: system notices, compaction blocks, betas.
    """

    request_timeout_sec: float = 600.0

    def _get_request_payload(self, input_: Any, *, stop: list[str] | None = None, **kwargs: Any) -> dict:
        messages = [_as_marked_message(message) for message in self._convert_input(input_).to_messages()]
        payload = super()._get_request_payload(messages, stop=stop, **kwargs)
        formatted = from_last_compaction(place_system_messages(payload.get('messages') or []))
        _clean_compaction_blocks(formatted)
        payload['messages'] = formatted
        betas = list(payload.get('betas') or [])
        if _has_tool_changes(formatted) or _carries_tool_changes(formatted):
            betas = _with_beta(betas, INLINE_TOOLS_BETA)
        if _uses_server_compaction(payload):
            betas = _with_beta(betas, COMPACTION_BETA)
        if betas:
            payload['betas'] = betas
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                'Claude request: %d messages, %d thinking blocks replayed, %d system messages, %d compaction blocks, betas %s',
                len(formatted),
                _count_blocks(formatted, 'thinking'),
                sum(message.get('role') == 'system' for message in formatted),
                _count_blocks(formatted, 'compaction'),
                betas,
            )
        return payload

    def _make_message_chunk_from_anthropic_event(self, event: Any, **kwargs: Any) -> Any:
        event_type = getattr(event, 'type', None)
        if event_type == 'content_block_start' and getattr(event.content_block, 'type', None) == 'compaction':
            # Kept as the block's start event; its fields join the block with the summary delta below.
            return None, event
        start_fields = _compaction_start_fields(kwargs.get('block_start_event'))
        if start_fields and event_type == 'content_block_delta' and getattr(event.delta, 'type', None) == 'signature_delta':
            block = {'type': 'compaction', 'signature': event.delta.signature, 'index': event.index}
            return AIMessageChunk(content=[block]), kwargs.get('block_start_event')
        chunk, block_start = super()._make_message_chunk_from_anthropic_event(event, **kwargs)
        if start_fields and chunk is not None and event_type == 'content_block_delta':
            for block in chunk.content if isinstance(chunk.content, list) else []:
                if isinstance(block, dict) and block.get('type') == 'compaction':
                    for key, value in start_fields.items():
                        block.setdefault(key, value)
            # The summary delta came through LangChain's own branch: the start event still belongs to this block.
            block_start = kwargs.get('block_start_event')
        if getattr(event, 'type', None) == 'message_delta' and chunk is not None:
            iterations = getattr(getattr(event, 'usage', None), 'iterations', None)
            if iterations:
                chunk.response_metadata['usage_iterations'] = [
                    entry.model_dump() if hasattr(entry, 'model_dump') else dict(entry) for entry in iterations
                ]
        if getattr(event, 'type', None) == 'message_start':
            entries = input_transformations(getattr(event, 'message', None))
            if entries is not None and chunk is not None:
                chunk.response_metadata['input_transformations'] = entries
                log_input_transformations(entries, self.model)
                logger.debug('Claude response input_transformations: %s', entries)
        return chunk, block_start

    @cached_property
    def _client(self) -> anthropic.Client:
        sync_client, _ = acquire_anthropic_http_clients(self.request_timeout_sec)
        return anthropic.Client(**self._client_params, http_client=sync_client)

    @cached_property
    def _async_client(self) -> anthropic.AsyncClient:
        _, async_client = acquire_anthropic_http_clients(self.request_timeout_sec)
        return anthropic.AsyncClient(**self._client_params, http_client=async_client)


def resolve_anthropic_effort(saved: str, allowed: list[str] | None, *, disable_thinking: bool) -> str | None:
    """Effort to send: what the composer shows (saved if offered, else ``medium``, else the first).

    ``disable_thinking`` (titles, briefings) asks for the lowest offered level. ``None`` when the
    model has no effort control.
    """
    if not allowed:
        return None
    if disable_thinking:
        return 'low' if 'low' in allowed else allowed[0]
    effort = (saved or '').strip().lower()
    if effort in allowed:
        return effort
    return 'medium' if 'medium' in allowed else allowed[0]


def build_anthropic_llm(
    connection: RuntimeConnection,
    *,
    idle_timeout_sec: float,
    disable_thinking: bool = False,
) -> ClaraChatAnthropic:
    """Build the Claude chat model for ``connection`` (provider ``anthropic``)."""
    api_key = connection.api_key or os.getenv('ANTHROPIC_API_KEY', '')
    require_openai_api_key(api_key, 'Claude')
    model = (connection.model or '').strip()
    if not model:
        raise HTTPException(status_code=500, detail='Pick a Claude model in Settings → Sources → Claude.')

    caps = connection.chat_template_reasoning if isinstance(connection.chat_template_reasoning, dict) else {}
    allowed_raw = caps.get('reasoningEffortValues')
    allowed = [str(v) for v in allowed_raw] if isinstance(allowed_raw, list) else None
    adaptive = bool(caps.get('adaptiveThinking'))

    max_tokens = int(llm_optional_kwargs(connection).get('max_tokens') or ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS)
    kwargs: dict[str, Any] = {
        'model': model,
        'api_key': api_key,
        'max_tokens': max_tokens,
        'streaming': True,
        'stream_usage': True,
        # Fail fast on a stalled stream rather than silently re-attempting in the background.
        'max_retries': 0,
        # Per-read idle timeout on the owned httpx2 clients (a long generation keeps streaming).
        'request_timeout_sec': float(idle_timeout_sec),
        'model_kwargs': {'cache_control': {'type': 'ephemeral'}},
    }
    if adaptive:
        kwargs['thinking'] = {
            'type': 'adaptive',
            'display': 'summarized',
            'block_binding': {'prefix_mismatch_behavior': 'drop_block'},
        }
        kwargs['betas'] = [THINKING_BINDING_BETA]
    effort = resolve_anthropic_effort(connection.reasoning_effort or '', allowed, disable_thinking=disable_thinking)
    if effort:
        kwargs['output_config'] = {'effort': effort}

    log_llm_connection_settings(
        {
            'provider': 'anthropic',
            'model': model,
            'api_key_configured': True,
            'streaming': True,
            'max_tokens': max_tokens,
            'thinking': 'adaptive' if adaptive else 'default',
            'effort': effort,
            'betas': kwargs.get('betas'),
            'idle_read_timeout_sec': idle_timeout_sec,
        }
    )
    return ClaraChatAnthropic(**kwargs)
