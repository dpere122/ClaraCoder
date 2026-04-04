"""Construct a LangChain ChatOpenAI client from the active runtime connection.

Supports OpenAI's API and LM Studio (OpenAI-compatible local server). Optional
``reasoning_effort`` is passed through for models that support it.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import HTTPException
from langchain_openai import ChatOpenAI

from nemo_backend.config import DEFAULT_LM_STUDIO_BASE_URL
from nemo_backend.state import get_active_connection, require_openai_api_key


def build_llm() -> ChatOpenAI:
    """Build a non-streaming ChatOpenAI instance for the agent (tools bound separately)."""
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
        raise HTTPException(status_code=500, detail=f'Unsupported LLM provider: {connection.provider}')

    kwargs: dict[str, Any] = {
        'model': connection.model,
        'temperature': 0,
        'streaming': False,
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

    return ChatOpenAI(**kwargs)
