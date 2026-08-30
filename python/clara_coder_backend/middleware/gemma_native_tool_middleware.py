"""Promote Gemma native ``<|tool_call>`` markup into structured LangChain ``tool_calls``."""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import AgentState, ResponseT
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime
from langgraph.typing import ContextT
from typing_extensions import override

from clara_coder_backend.llm.gemma_output import (
    extract_gemma_native_tool_calls,
    gemma_content_needs_parsing,
    normalize_gemma_tool_args,
    split_gemma_channels,
    strip_gemma_channel_markup,
    strip_gemma_native_tool_call_blocks,
)
from clara_coder_backend.llm.messages import reasoning_sidecar_text, stringify_content

logger = logging.getLogger('clara.agent.langgraph')


def _gemma_native_tools_active() -> bool:
    """True when the Gemma optimization preset should promote native ``<|tool_call>`` markup."""
    try:
        from clara_coder_backend.llm.model_tuning import gemma_output_parsing_active
        from clara_coder_backend.session.state import get_active_connection

        return bool(gemma_output_parsing_active(get_active_connection()))
    except Exception:
        return False


def _candidate_texts(message: AIMessage) -> list[str]:
    texts: list[str] = []
    raw = stringify_content(message.content)
    if raw.strip():
        texts.append(raw)
    extra = str(getattr(message, 'text', None) or '')
    if extra.strip() and extra not in texts:
        texts.append(extra)
    reason = reasoning_sidecar_text(message)
    if reason.strip() and reason not in texts:
        texts.append(reason)
    return texts


def _existing_reasoning(message: AIMessage) -> str:
    ak = getattr(message, 'additional_kwargs', None) or {}
    for key in ('reasoning_content', 'reasoning'):
        val = ak.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    r = getattr(message, 'reasoning', None)
    if isinstance(r, str) and r.strip():
        return r.strip()
    return ''


def _normalize_tool_call_args(tool_calls: list[Any]) -> list[Any] | None:
    """Rewrite ``path``/``content`` aliases on already-structured API tool_calls."""
    changed = False
    out: list[Any] = []
    for call in tool_calls:
        if isinstance(call, dict):
            args = call.get('args') if isinstance(call.get('args'), dict) else {}
            normalized = normalize_gemma_tool_args(args)
            if normalized != args:
                changed = True
                out.append({**call, 'args': normalized})
            else:
                out.append(call)
            continue
        args = getattr(call, 'args', None)
        if not isinstance(args, dict):
            out.append(call)
            continue
        normalized = normalize_gemma_tool_args(args)
        if normalized == args:
            out.append(call)
            continue
        changed = True
        if hasattr(call, 'model_copy'):
            out.append(call.model_copy(update={'args': normalized}))
        else:
            out.append(call)
    return out if changed else None


class GemmaNativeToolMiddleware(AgentMiddleware):
    """Convert Gemma ``<|tool_call>call:name{...}<tool_call|>`` text into executable tool calls.

    Also moves ``<|channel>thought`` interiors onto ``reasoning_content`` so the GGUF Jinja
    template can replay thought between tool-call turns (it strips channels from ``content``).
    """

    @override
    async def aafter_model(
        self,
        state: AgentState[ResponseT],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        del runtime  # API contract; unused
        if not _gemma_native_tools_active():
            return None
        msgs = state.get('messages') or []
        if not msgs:
            return None
        last = msgs[-1]
        if not isinstance(last, AIMessage):
            return None
        raw = stringify_content(last.content)
        has_api_calls = bool(last.tool_calls or getattr(last, 'invalid_tool_calls', None))
        calls: list[dict[str, Any]] = []
        if not has_api_calls:
            for text in _candidate_texts(last):
                calls = extract_gemma_native_tool_calls(text)
                if calls:
                    break
        normalized_api = (
            _normalize_tool_call_args(list(last.tool_calls or [])) if has_api_calls else None
        )
        needs_channel = gemma_content_needs_parsing(raw)
        if not calls and not needs_channel and normalized_api is None:
            return None
        visible, split_reason = split_gemma_channels(raw) if needs_channel else (raw, '')
        visible = strip_gemma_native_tool_call_blocks(visible).strip()
        ak = dict(last.additional_kwargs or {})
        reason = strip_gemma_channel_markup(_existing_reasoning(last) or split_reason)
        if calls:
            reason = strip_gemma_native_tool_call_blocks(reason).strip()
        if not calls and normalized_api is None and not split_reason and visible == raw.strip():
            return None
        if reason and not str(ak.get('reasoning_content') or '').strip():
            ak['reasoning_content'] = reason
        if calls:
            logger.info('Promoted Gemma native tool syntax to API tool_calls (%s call(s))', len(calls))
        updated_fields: dict[str, Any] = {
            'content': visible,
            'additional_kwargs': ak,
        }
        if calls:
            updated_fields['tool_calls'] = calls
        elif normalized_api is not None:
            updated_fields['tool_calls'] = normalized_api
        return {'messages': [last.model_copy(update=updated_fields)]}
