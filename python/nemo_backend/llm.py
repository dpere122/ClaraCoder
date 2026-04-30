"""Construct a LangChain ChatOpenAI client from the active runtime connection.

Uses the ``openai`` Python package (via ``langchain-openai``) against OpenAI-compatible endpoints.
:class:`~langchain_openai.ChatOpenAI` is configured with ``stream_usage=True`` so streaming runs request
``stream_options: {include_usage: true}`` and completed assistant turns carry LangChain
:class:`~langchain_core.messages.AIMessage.usage_metadata` (prompt, completion, and total tokens) where the
server supports it (OpenAI, LM Studio, recent ``llama-server``, etc.).

Supports OpenAI's API, LM Studio, and llama.cpp’s OpenAI-compatible HTTP server. Streaming is
enabled for token-by-token :meth:`~langchain_core.language_models.chat_models.BaseChatModel.astream`.
Optional ``reasoning_effort`` is passed through for models that support it
(``none|minimal|low|medium|high|xhigh`` on current OpenAI-style APIs). UI values ``on`` / ``off``
are mapped to ``medium`` / ``none`` so the wire value is always API-valid.
``nemo_backend.model_tuning`` may add ``max_tokens`` for the Qwen or Gemma **optimization templates**
when selected, optional per-preset sampling from Settings (``top_p``, ``top_k``, ``min_p``, ``presence_penalty``,
``repeat_penalty``), and Gemma-specific ``top_p`` / ``top_k`` via the Gemma sampling preset (merging ``extra_body``
for locals such as LM Studio / ``llama-server``). OpenAI-style ``reasoning_effort`` is omitted when the Gemma
template is active (use Gemma thinking settings instead).
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import HTTPException
from langchain_openai import ChatOpenAI

from nemo_backend.config import DEFAULT_LLAMACPP_BASE_URL, DEFAULT_LM_STUDIO_BASE_URL
from nemo_backend.llm_interaction_logging import log_llm_connection_settings
from nemo_backend.model_tuning import (
    connection_user_sampling_kwargs_for_llm,
    gemma_optimize_profile_active,
    gemma_sampling_kwargs_for_llm,
    llm_optional_kwargs,
)
from nemo_backend.state import get_active_connection, require_openai_api_key

logger = logging.getLogger('nemo.llm')

# OpenAI (and aligned gateways) reject arbitrary strings; ``on``/``off`` are app UI aliases only.
_REASONING_API_VALUES = frozenset({'none', 'minimal', 'low', 'medium', 'high', 'xhigh'})


def _resolve_reasoning_effort(raw: str) -> str | None:
    """Return ``reasoning_effort`` to send to the API, or ``None`` to omit the parameter."""
    e = (raw or '').strip().lower()
    if not e:
        return None
    if e == 'on':
        return 'medium'
    if e == 'off':
        return 'none'
    if e in _REASONING_API_VALUES:
        return e
    return None


def build_llm() -> ChatOpenAI:
    """Build a ChatOpenAI instance for the agent (tools bound separately).

    Streaming is enabled so :meth:`~langchain_core.language_models.chat_models.BaseChatModel.astream`
    yields token chunks; the agent loop forwards them as SSE while still assembling full turns
    for tool calling.
    """
    connection = get_active_connection()
    base_url = connection.base_url
    api_key = connection.api_key

    if connection.provider == 'openai':
        api_key = api_key or os.getenv('OPENAI_API_KEY', '')
        require_openai_api_key(api_key, 'OpenAI')
    elif connection.provider == 'lmstudio':
        base_url = connection.base_url or DEFAULT_LM_STUDIO_BASE_URL
        api_key = connection.api_key or os.getenv('LM_STUDIO_API_KEY', 'lm-studio')
    elif connection.provider == 'llamacpp':
        base_url = connection.base_url or DEFAULT_LLAMACPP_BASE_URL
        api_key = connection.api_key or os.getenv('LLAMACPP_API_KEY', 'not-needed')
    else:
        logger.error('Unsupported LLM provider: %s', connection.provider)
        raise HTTPException(status_code=500, detail=f'Unsupported LLM provider: {connection.provider}')

    kwargs: dict[str, Any] = {
        'model': connection.model,
        'temperature': float(connection.temperature),
        'streaming': True,
        # LangChain passes ``stream_options: {include_usage: true}`` to the OpenAI SDK so streaming
        # completions include usage chunks (OpenAI + many OpenAI-compatible servers, e.g. llama-server).
        # Without this, custom ``base_url`` disables stream_usage by default.
        'stream_usage': True,
    }
    if base_url:
        kwargs['base_url'] = base_url
    if api_key:
        kwargs['api_key'] = api_key

    # Per-connection UI setting, with env fallback for headless/dev use.
    # Gemma template uses boolean thinking via LM Studio / chat template, not OpenAI-style reasoning_effort.
    if not gemma_optimize_profile_active(connection):
        effort_raw = (connection.reasoning_effort or '').strip().lower()
        if not effort_raw:
            effort_raw = (os.getenv('NEMO_REASONING_EFFORT', '') or '').strip().lower()
        resolved = _resolve_reasoning_effort(effort_raw)
        if resolved is not None:
            kwargs['reasoning_effort'] = resolved

    kwargs.update(llm_optional_kwargs(connection))

    user_sampling = connection_user_sampling_kwargs_for_llm(connection)
    eb_user = user_sampling.pop('extra_body', None)
    if eb_user:
        base_eb = dict(kwargs.get('extra_body') or {})
        base_eb.update(eb_user)
        kwargs['extra_body'] = base_eb
    kwargs.update(user_sampling)

    gemma_sampling = gemma_sampling_kwargs_for_llm(connection)
    eb_extra = gemma_sampling.pop('extra_body', None)
    if eb_extra:
        base_eb = dict(kwargs.get('extra_body') or {})
        base_eb.update(eb_extra)
        kwargs['extra_body'] = base_eb
    kwargs.update(gemma_sampling)

    safe: dict[str, Any] = {
        'provider': connection.provider,
        'model': kwargs['model'],
        'temperature': kwargs['temperature'],
        'base_url': kwargs.get('base_url'),
        'api_key_configured': bool(kwargs.get('api_key')),
        'streaming': kwargs.get('streaming'),
    }
    if 'reasoning_effort' in kwargs:
        safe['reasoning_effort'] = kwargs['reasoning_effort']
    for k, v in kwargs.items():
        if k in ('api_key', 'model', 'temperature', 'streaming', 'base_url', 'reasoning_effort'):
            continue
        safe[k] = v
    log_llm_connection_settings(safe)

    return ChatOpenAI(**kwargs)
