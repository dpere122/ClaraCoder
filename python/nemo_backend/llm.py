"""Construct a LangChain ChatOpenAI client from the active runtime connection.

Supports OpenAI's API and LM Studio (OpenAI-compatible local server). Streaming is
enabled for token-by-token :meth:`~langchain_core.language_models.chat_models.BaseChatModel.astream`.
Optional ``reasoning_effort`` is passed through for models that support it.
``nemo_backend.model_tuning`` may add ``max_tokens`` for Qwen-family models when enabled.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import HTTPException
from langchain_openai import ChatOpenAI

from nemo_backend.config import DEFAULT_LM_STUDIO_BASE_URL
from nemo_backend.llm_interaction_logging import log_llm_connection_settings
from nemo_backend.model_tuning import llm_optional_kwargs
from nemo_backend.state import get_active_connection, require_openai_api_key

logger = logging.getLogger('nemo.llm')


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
    else:
        logger.error('Unsupported LLM provider: %s', connection.provider)
        raise HTTPException(status_code=500, detail=f'Unsupported LLM provider: {connection.provider}')

    kwargs: dict[str, Any] = {
        'model': connection.model,
        'temperature': float(connection.temperature),
        'streaming': True,
    }
    if base_url:
        kwargs['base_url'] = base_url
    if api_key:
        kwargs['api_key'] = api_key

    # Per-connection UI setting, with env fallback for headless/dev use.
    effort = (connection.reasoning_effort or '').strip().lower()
    if not effort:
        effort = (os.getenv('NEMO_REASONING_EFFORT', '') or '').strip().lower()
    if effort in ('minimal', 'low', 'medium', 'high'):
        kwargs['reasoning_effort'] = effort

    kwargs.update(llm_optional_kwargs(connection))

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
