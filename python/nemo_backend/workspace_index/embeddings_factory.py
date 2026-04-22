"""OpenAI-compatible embeddings from the active :class:`~nemo_backend.domain.RuntimeConnection`."""

from __future__ import annotations

import logging
import os
from typing import Any

from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.embeddings.openai import OpenAIEmbedding

from nemo_backend.config import (
    DEFAULT_LLAMACPP_BASE_URL,
    DEFAULT_LM_STUDIO_BASE_URL,
    NEMO_EMBEDDINGS_API_KEY,
    NEMO_EMBEDDINGS_BASE_URL,
    NEMO_EMBEDDINGS_MODEL,
)
from nemo_backend.domain import RuntimeConnection
from nemo_backend.state import require_openai_api_key

logger = logging.getLogger('nemo.workspace_index.embeddings')


def normalize_openai_api_base(raw: str) -> str | None:
    """Return ``api_base`` for the OpenAI SDK (``.../v1``) or ``None`` for library defaults."""
    s = (raw or '').strip()
    if not s:
        return None
    s = s.rstrip('/')
    if s.endswith('/v1'):
        return s
    return f'{s}/v1'


def _llamacpp_embeddings_disabled(connection: RuntimeConnection) -> bool:
    """True when this llama.cpp model preset has no embedding server and no dedicated embeddings endpoint."""
    if connection.provider != 'llamacpp':
        return False
    if getattr(connection, 'embeddings_enabled', True):
        return False
    if NEMO_EMBEDDINGS_BASE_URL:
        return False
    if (getattr(connection, 'embeddings_base_url', None) or '').strip():
        return False
    return True


def build_embedding_model(connection: RuntimeConnection) -> tuple[BaseEmbedding | None, str]:
    """Construct ``OpenAIEmbedding`` from *connection* settings, or return ``(None, error_message)``.

    When ``NEMO_EMBEDDINGS_BASE_URL`` is set (see :mod:`nemo_backend.config`), embeddings use that OpenAI-compatible
    base URL instead of the chat connection's ``base_url``—so a dedicated local server (e.g. ``llama-server`` with
    ``--embedding`` on port 8081) can run alongside the main chat ``llama-server`` on port 8080.

    For **llama.cpp** presets, embeddings are skipped when the UI has no embedding model/server configured
    (``embeddings_enabled`` is false), unless ``NEMO_EMBEDDINGS_BASE_URL`` or per-connection ``embeddings_base_url``
    supplies a dedicated endpoint.
    """
    if _llamacpp_embeddings_disabled(connection):
        return (
            None,
            'Semantic index / embeddings are disabled for this llama.cpp model preset. '
            'Enable the embedding server in Settings (Models → Embedding), or set NEMO_EMBEDDINGS_BASE_URL '
            'to a dedicated OpenAI-compatible embeddings API.',
        )

    model = NEMO_EMBEDDINGS_MODEL or 'text-embedding-3-small'
    base_url = (connection.base_url or '').strip()
    api_key = (connection.api_key or '').strip()

    if connection.provider == 'openai':
        api_key = api_key or os.getenv('OPENAI_API_KEY', '')
        try:
            require_openai_api_key(api_key, 'OpenAI')
        except Exception as exc:
            return None, f'Embeddings unavailable: {exc}'
        api_base = normalize_openai_api_base(base_url)
    elif connection.provider == 'lmstudio':
        base_url = base_url or DEFAULT_LM_STUDIO_BASE_URL
        api_key = api_key or os.getenv('LM_STUDIO_API_KEY', 'lm-studio')
        api_base = normalize_openai_api_base(base_url)
    elif connection.provider == 'llamacpp':
        base_url = base_url or DEFAULT_LLAMACPP_BASE_URL
        api_key = api_key or os.getenv('LLAMACPP_API_KEY', 'not-needed')
        api_base = normalize_openai_api_base(base_url)
    else:
        return None, f'Embeddings unavailable: unsupported provider {connection.provider!r}.'

    conn_emb = (getattr(connection, 'embeddings_base_url', None) or '').strip()
    if conn_emb:
        api_base = normalize_openai_api_base(conn_emb)
    elif NEMO_EMBEDDINGS_BASE_URL:
        api_base = normalize_openai_api_base(NEMO_EMBEDDINGS_BASE_URL)
    if NEMO_EMBEDDINGS_API_KEY:
        api_key = NEMO_EMBEDDINGS_API_KEY.strip()

    # Managed llama.cpp stopped: Electron forwards chat base URL with port 0. Avoid embedding HTTP calls.
    if (
        connection.provider == 'llamacpp'
        and api_base
        and ':0/v1' in api_base.replace('\\', '/')
    ):
        return (
            None,
            'Semantic index / embeddings are unavailable until the managed llama.cpp server is started, '
            'or set NEMO_EMBEDDINGS_BASE_URL / a per-preset embeddings base URL to a running OpenAI-compatible endpoint.',
        )

    kwargs: dict[str, Any] = {
        'model': model,
        'api_key': api_key,
        'timeout': 120.0,
        'max_retries': 2,
    }
    if api_base:
        kwargs['api_base'] = api_base

    try:
        embed = OpenAIEmbedding(**kwargs)
        embed.get_query_embedding('nemo')
    except Exception as exc:
        logger.info('Embedding probe failed: %s', exc)
        hint = (
            'The active LLM server rejected or does not implement OpenAI-style POST /v1/embeddings. '
            'For LM Studio or llama.cpp, either enable embeddings on the chat server, or run a dedicated ``llama-server`` '
            'with ``--embedding`` and point ``NEMO_EMBEDDINGS_BASE_URL`` / ``NEMO_EMBEDDINGS_MODEL`` at it; '
            'or use an OpenAI connection for chat/embeddings.'
        )
        return None, f'Semantic index unavailable ({type(exc).__name__}: {exc}). {hint}'

    return embed, ''
