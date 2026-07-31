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
            for key in ('reasoning_content', 'reasoning'):
                coerced = _coerce_reasoning_wire_value(mapping.get(key)).strip()
                if coerced:
                    ak = dict(msg.additional_kwargs or {})
                    ak.setdefault(key, coerced)
                    msg.additional_kwargs = ak
                    break
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
        ak_updates: dict[str, str] = {}
        for key in ('reasoning_content', 'reasoning'):
            coerced = _coerce_reasoning_wire_value(mapping.get(key))
            if coerced:
                ak_updates[key] = coerced
        if not ak_updates:
            return chunk
        ak = dict(chunk.additional_kwargs or {})
        ak.update(ak_updates)
        chunk.additional_kwargs = ak
        return chunk

    lc_openai_base._convert_delta_to_message_chunk = _convert_delta_to_message_chunk

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
