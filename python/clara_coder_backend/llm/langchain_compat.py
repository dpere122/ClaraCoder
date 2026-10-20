"""Compatibility shims for LangChain + OpenAI-style reasoning fields.

Some OpenAI-compatible servers return assistant reasoning in fields such as
``reasoning_content`` while leaving ``content`` empty. LangChain's default
message converter did not copy those fields onto :class:`~langchain_core.messages.AIMessage`,
which made the agent loop think the model returned nothing. The streaming path
(:func:`_convert_delta_to_message_chunk` in ``langchain_openai``) also dropped
``reasoning_content`` / ``reasoning`` on each SSE delta—so servers like
``llama-server`` with Qwen/DeepSeek-style thinking never produced visible
``AIMessageChunk`` text until this patch. This module patches the converters once
at process startup.

OpenRouter also returns ``reasoning_details``: structured reasoning blocks, including
encrypted ones (``reasoning.encrypted``, e.g. Gemini thought signatures) that carry no
readable text. OpenRouter asks clients to send those blocks back unchanged on the assistant
message of a tool loop so the model keeps its reasoning state between tool calls. They are
kept on ``additional_kwargs['reasoning_details']`` and echoed on outgoing assistant dicts.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, BaseMessageChunk
from langchain_openai import ChatOpenAI


def _coerce_reasoning_wire_value(raw: Any) -> str:
    """Normalize ``reasoning_content`` / ``reasoning`` from wire JSON (str, list, or block dicts)."""
    if raw is None:
        return ''
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (list, tuple)):
        parts: list[str] = []
        for item in raw:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                nested = item.get('text') or item.get('content') or item.get('reasoning')
                if isinstance(nested, str):
                    parts.append(nested)
        return ''.join(parts)
    return ''


#: Original wire ``index`` of a streamed ``reasoning_details`` fragment. LangChain merges list
#: items that share an int ``index`` key, which would concatenate ``type`` / ``format`` strings
#: across fragments; renaming keeps fragments apart until :func:`consolidate_reasoning_details`.
_STREAM_INDEX_KEY = '_clara_index'

#: Fields that stream in pieces and concatenate when fragments of one block are joined.
_REASONING_DETAIL_TEXT_KEYS = ('text', 'summary', 'data')


def _stream_reasoning_details(raw: Any) -> list[dict[str, Any]]:
    """Copy SSE ``delta.reasoning_details`` items with ``index`` renamed (see ``_STREAM_INDEX_KEY``)."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        frag = dict(item)
        if 'index' in frag:
            frag[_STREAM_INDEX_KEY] = frag.pop('index')
        out.append(frag)
    return out


def consolidate_reasoning_details(items: Any) -> list[dict[str, Any]]:
    """Join streamed ``reasoning_details`` fragments back into whole blocks for the wire.

    Consecutive fragments with the same ``type`` and wire index are one block: their text
    fields concatenate and the first non-empty value of every other field wins.
    """
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        idx = item.pop(_STREAM_INDEX_KEY, item.get('index'))
        prev = out[-1] if out else None
        if (
            prev is not None
            and idx is not None
            and prev.get('index') == idx
            and prev.get('type') == item.get('type')
        ):
            for key, val in item.items():
                if key in _REASONING_DETAIL_TEXT_KEYS and isinstance(val, str):
                    prev[key] = (prev.get(key) or '') + val
                elif prev.get(key) in (None, ''):
                    prev[key] = val
            continue
        if idx is not None:
            item['index'] = idx
        out.append(item)
    return out


def reasoning_details_text(items: Any) -> str:
    """Readable text from ``reasoning.text`` / ``reasoning.summary`` blocks (encrypted ones have none)."""
    if not isinstance(items, list):
        return ''
    parts: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        kind = item.get('type')
        key = 'summary' if kind == 'reasoning.summary' else 'text' if kind == 'reasoning.text' else None
        val = item.get(key) if key else None
        if isinstance(val, str):
            parts.append(val)
    return ''.join(parts)


def install_langchain_reasoning_content_compat() -> None:
    """Monkey-patch LangChain OpenAI integration to preserve reasoning text on AIMessage.

    Idempotent: safe to call multiple times; only the first call installs patches.
    """
    # Use function attribute as a process-wide "already installed" flag.
    if getattr(install_langchain_reasoning_content_compat, '_nemo_done', False):
        return
    setattr(install_langchain_reasoning_content_compat, '_nemo_done', True)

    try:
        from langchain_openai.chat_models import base as lc_openai_base
    except ImportError:
        # LangChain layout changed; skip rather than crash the server.
        return

    _orig_convert = lc_openai_base._convert_dict_to_message

    def _convert_dict_to_message(mapping: Any) -> BaseMessage:
        """Wrap dict-to-message: copy reasoning_* from raw API dict into additional_kwargs."""
        msg = _orig_convert(mapping)
        if isinstance(msg, AIMessage) and mapping.get('role') == 'assistant':
            ak = dict(msg.additional_kwargs or {})
            for key in ('reasoning_content', 'reasoning'):
                coerced = _coerce_reasoning_wire_value(mapping.get(key)).strip()
                if coerced:
                    ak.setdefault(key, coerced)
                    break
            details = mapping.get('reasoning_details')
            if isinstance(details, list) and details:
                ak.setdefault('reasoning_details', [dict(d) for d in details if isinstance(d, dict)])
                if not (ak.get('reasoning_content') or ak.get('reasoning')):
                    text = reasoning_details_text(details).strip()
                    if text:
                        ak['reasoning'] = text
            if ak != (msg.additional_kwargs or {}):
                msg.additional_kwargs = ak
        return msg

    lc_openai_base._convert_dict_to_message = _convert_dict_to_message

    _orig_delta_convert = lc_openai_base._convert_delta_to_message_chunk

    def _convert_delta_to_message_chunk(
        mapping: Any,
        default_class: type[BaseMessageChunk],
    ) -> BaseMessageChunk:
        """Wrap delta→chunk: preserve per-token ``reasoning_content`` / ``reasoning`` (llama.cpp, etc.)."""
        chunk = _orig_delta_convert(mapping, default_class)
        if not isinstance(chunk, AIMessageChunk) or not isinstance(mapping, dict):
            return chunk
        ak_updates: dict[str, Any] = {}
        for key in ('reasoning_content', 'reasoning'):
            coerced = _coerce_reasoning_wire_value(mapping.get(key))
            if coerced:
                ak_updates[key] = coerced
        details = _stream_reasoning_details(mapping.get('reasoning_details'))
        if details:
            ak_updates['reasoning_details'] = details
            # OpenRouter normally mirrors readable reasoning into ``reasoning``; read the
            # structured blocks only when it did not, so the thought pill never doubles.
            if not ak_updates.keys() & {'reasoning_content', 'reasoning'}:
                text = reasoning_details_text(details)
                if text:
                    ak_updates['reasoning'] = text
        if not ak_updates:
            return chunk
        ak = dict(chunk.additional_kwargs or {})
        ak.update(ak_updates)
        chunk.additional_kwargs = ak
        return chunk

    lc_openai_base._convert_delta_to_message_chunk = _convert_delta_to_message_chunk

    _orig_message_to_dict = lc_openai_base._convert_message_to_dict

    def _convert_message_to_dict(message: BaseMessage, *args: Any, **kwargs: Any) -> dict:
        """Wrap message→dict: echo ``reasoning_details`` on assistant turns (OpenRouter tool loops)."""
        out = _orig_message_to_dict(message, *args, **kwargs)
        if isinstance(message, AIMessage) and out.get('role') == 'assistant':
            details = consolidate_reasoning_details((message.additional_kwargs or {}).get('reasoning_details'))
            if details:
                out['reasoning_details'] = details
        return out

    lc_openai_base._convert_message_to_dict = _convert_message_to_dict

    _orig_chat_result = ChatOpenAI._create_chat_result

    def _create_chat_result(self: Any, response: Any, generation_info: dict[str, Any] | None = None) -> Any:
        """Wrap result builder: also copy reasoning from SDK message object if present."""
        result = _orig_chat_result(self, response, generation_info)
        try:
            choices = getattr(response, 'choices', None)
            if choices and result.generations:
                omsg = choices[0].message
                dst = result.generations[0].message
                if isinstance(dst, AIMessage):
                    rc = _coerce_reasoning_wire_value(getattr(omsg, 'reasoning_content', None))
                    if not rc.strip():
                        rc = _coerce_reasoning_wire_value(getattr(omsg, 'reasoning', None))
                    if rc.strip():
                        ak = dict(dst.additional_kwargs or {})
                        ak.setdefault('reasoning_content', rc.strip())
                        dst.additional_kwargs = ak
        except Exception:
            # Never break chat on metadata extraction failures.
            pass
        return result

    ChatOpenAI._create_chat_result = _create_chat_result  # type: ignore[method-assign]


# Apply as soon as this package is imported (before first ChatOpenAI use).
install_langchain_reasoning_content_compat()
