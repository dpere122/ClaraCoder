"""Compatibility shims for LangChain + OpenAI-style reasoning fields.

Some OpenAI-compatible servers return assistant reasoning in fields such as
``reasoning_content`` while leaving ``content`` empty. LangChain's default
message converter did not copy those fields onto :class:`~langchain_core.messages.AIMessage`,
which made the agent loop think the model returned nothing. This module patches
the converter once at process startup.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, BaseMessage
from langchain_openai import ChatOpenAI


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
                raw = mapping.get(key)
                if isinstance(raw, str) and raw.strip():
                    ak = dict(msg.additional_kwargs or {})
                    ak.setdefault(key, raw.strip())
                    msg.additional_kwargs = ak
                    break
        return msg

    lc_openai_base._convert_dict_to_message = _convert_dict_to_message

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
                    rc = getattr(omsg, 'reasoning_content', None)
                    if isinstance(rc, str) and rc.strip():
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
