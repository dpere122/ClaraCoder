"""Log LLM connection settings and chat turns. Never logs API keys or secrets."""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from clara_coder_backend.llm.messages import stringify_content

logger = logging.getLogger('clara.llm')

_TRUNC_INFO = 8_000
_TRUNC_DEBUG = 120_000

_last_connection_fingerprint: str | None = None


def _limit() -> int:
    return _TRUNC_DEBUG if logger.isEnabledFor(logging.DEBUG) else _TRUNC_INFO


def _preview(text: str, max_len: int | None = None) -> str:
    cap = max_len if max_len is not None else _limit()
    if len(text) <= cap:
        return text
    return text[: max(0, cap - 24)] + '\n… [truncated for log]\n'


def connection_fingerprint(safe: dict[str, Any]) -> str:
    return json.dumps(safe, sort_keys=True, default=str)


def log_llm_user_request(
    user_text: str,
    *,
    session_id: str,
    apply_mode: bool,
    auto_apply_mode: bool,
    structured: bool = False,
) -> None:
    """Log the chat user turn that will be sent to the agent (same pipeline as ``/logs/*``)."""
    if not logger.isEnabledFor(logging.INFO):
        return
    body: dict[str, Any] = {
        'session_id': session_id,
        'user_message': _preview((user_text or '').strip(), _limit()),
        'apply_mode': apply_mode,
        'auto_apply_mode': auto_apply_mode,
        'structured_input': structured,
    }
    logger.info('LLM user request %s', json.dumps(body, ensure_ascii=False, default=str))


def log_llm_connection_settings(safe: dict[str, Any]) -> None:
    """Log resolved chat model settings (no secrets). Duplicate profiles log at DEBUG only."""
    global _last_connection_fingerprint
    fp = connection_fingerprint(safe)
    if fp == _last_connection_fingerprint:
        logger.debug('LLM client build (settings unchanged)')
        return
    _last_connection_fingerprint = fp
    logger.info('LLM connection %s', json.dumps(safe, ensure_ascii=False, sort_keys=True, default=str))


def _coerce_message(item: Any) -> BaseMessage | None:
    if isinstance(item, BaseMessage):
        return item
    if not isinstance(item, dict):
        return None
    role = (item.get('role') or item.get('type') or '').lower()
    content = item.get('content', '')
    if role in ('system', 'developer'):
        return SystemMessage(content=stringify_content(content))
    if role in ('user', 'human'):
        return HumanMessage(content=stringify_content(content))
    if role in ('assistant', 'ai'):
        return AIMessage(content=stringify_content(content))
    if role == 'tool':
        return ToolMessage(
            content=stringify_content(content),
            tool_call_id=str(item.get('tool_call_id') or item.get('id') or ''),
            name=str(item.get('name') or '') or 'tool',
        )
    return None


def coerce_messages_for_log(raw: Any) -> list[BaseMessage]:
    if raw is None:
        return []
    if isinstance(raw, list):
        out: list[BaseMessage] = []
        for item in raw:
            m = _coerce_message(item)
            if m is not None:
                out.append(m)
        return out
    if isinstance(raw, dict):
        inner = raw.get('messages')
        if inner is not None:
            return coerce_messages_for_log(inner)
    return []


def summarize_message(m: BaseMessage) -> dict[str, Any]:
    if isinstance(m, SystemMessage):
        text = stringify_content(m.content)
        return {'class': 'SystemMessage', 'chars': len(text), 'text': _preview(text)}
    if isinstance(m, HumanMessage):
        text = stringify_content(m.content)
        return {'class': 'HumanMessage', 'chars': len(text), 'text': _preview(text)}
    if isinstance(m, AIMessage):
        text = stringify_content(m.content)
        tc_raw = getattr(m, 'tool_calls', None) or []
        calls: list[dict[str, Any]] = []
        for c in tc_raw:
            if isinstance(c, dict):
                name = str(c.get('name') or '')
                args = c.get('args')
                arg_s = _preview(json.dumps(args, ensure_ascii=False, default=str), min(_limit(), 16_000))
                calls.append({'name': name, 'args': arg_s})
        return {
            'class': 'AIMessage',
            'chars': len(text),
            'text': _preview(text),
            'tool_calls': calls,
        }
    if isinstance(m, ToolMessage):
        text = stringify_content(m.content)
        return {
            'class': 'ToolMessage',
            'name': getattr(m, 'name', None),
            'tool_call_id': getattr(m, 'tool_call_id', None),
            'chars': len(text),
            'text': _preview(text),
        }
    text = stringify_content(getattr(m, 'content', m))
    return {'class': type(m).__name__, 'chars': len(text), 'text': _preview(text)}


def log_llm_chat_request(
    messages: list[BaseMessage],
    *,
    context: str,
    step: int | None = None,
    agent_role: str | None = None,
    llm_step: int | None = None,
) -> None:
    if not logger.isEnabledFor(logging.INFO):
        return
    payload = [summarize_message(m) for m in messages]
    bits = [f'context={context}']
    if step is not None:
        bits.append(f'agent_step={step}')
    if llm_step is not None:
        bits.append(f'llm_step={llm_step}')
    if agent_role:
        bits.append(f'agent_role={agent_role}')
    logger.info('LLM request %s message_count=%s %s', ' '.join(bits), len(messages), json.dumps(payload, ensure_ascii=False, default=str))


def log_llm_chat_response(
    message: AIMessage,
    *,
    context: str,
    step: int | None = None,
    agent_role: str | None = None,
    llm_step: int | None = None,
    stream_chunks: int | None = None,
    stream_chars: int | None = None,
) -> None:
    if not logger.isEnabledFor(logging.INFO):
        return
    summary = summarize_message(message)
    bits = [f'context={context}']
    if step is not None:
        bits.append(f'agent_step={step}')
    if llm_step is not None:
        bits.append(f'llm_step={llm_step}')
    if agent_role:
        bits.append(f'agent_role={agent_role}')
    sc = stream_chunks if stream_chunks is not None else None
    sch = stream_chars if stream_chars is not None else None
    stream_part = ''
    if sc is not None and sch is not None:
        stream_part = f' stream_chunks={sc} stream_chars={sch}'
    logger.info('LLM response %s%s %s', ' '.join(bits), stream_part, json.dumps(summary, ensure_ascii=False, default=str))


def log_llm_chat_request_from_event_input(
    raw_input: Any,
    *,
    context: str,
    agent_role: str | None = None,
    llm_step: int | None = None,
) -> None:
    msgs = coerce_messages_for_log(raw_input)
    if msgs:
        log_llm_chat_request(msgs, context=context, agent_role=agent_role, llm_step=llm_step)
    elif logger.isEnabledFor(logging.DEBUG):
        keys = list(raw_input.keys()) if isinstance(raw_input, dict) else type(raw_input).__name__
        logger.debug('LLM request (unparsed input) context=%s llm_step=%s keys_or_type=%s', context, llm_step, keys)


def log_llm_failure(exc: BaseException, *, context: str, agent_role: str | None = None, step: int | None = None) -> None:
    logger.error(
        'LLM failure context=%s agent_role=%s agent_step=%s %s: %s',
        context,
        agent_role,
        step,
        type(exc).__name__,
        exc,
        exc_info=True,
    )
