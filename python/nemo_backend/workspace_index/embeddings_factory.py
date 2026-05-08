"""OpenAI-compatible embeddings from the active :class:`~nemo_backend.domain.RuntimeConnection`."""

from __future__ import annotations

import logging
import math
import os
import time
from typing import Any

from llama_index.core.bridge.pydantic import PrivateAttr
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.embeddings.openai import OpenAIEmbedding

from nemo_backend.config import (
    DEFAULT_LLAMACPP_BASE_URL,
    DEFAULT_LM_STUDIO_BASE_URL,
    NEMO_EMBEDDINGS_API_KEY,
    NEMO_EMBEDDINGS_BASE_URL,
    NEMO_EMBEDDINGS_MAX_INPUT_TOKENS,
    NEMO_EMBEDDINGS_MODEL,
)
from nemo_backend.domain import RuntimeConnection
from nemo_backend.state import require_openai_api_key

logger = logging.getLogger('nemo.workspace_index.embeddings')

# Skip redundant probe HTTP calls when the same connection signature succeeded recently.
_EMBEDDING_PROBE_TTL_SEC = 120.0
_embedding_probe_ok_mono: dict[str, float] = {}
_EMBEDDING_PROBE_CACHE_MAX = 64


def resolve_embedding_model_id(connection: RuntimeConnection) -> str:
    """Effective OpenAI-compatible embeddings model id (matches :func:`build_embedding_model`)."""
    return (
        (getattr(connection, 'embeddings_model', None) or '').strip()
        or (NEMO_EMBEDDINGS_MODEL or 'text-embedding-3-small')
    )


def _prune_embedding_probe_cache(now: float) -> None:
    ttl = _EMBEDDING_PROBE_TTL_SEC
    stale = [k for k, ts in _embedding_probe_ok_mono.items() if (now - ts) >= ttl]
    for k in stale:
        _embedding_probe_ok_mono.pop(k, None)
    while len(_embedding_probe_ok_mono) > _EMBEDDING_PROBE_CACHE_MAX:
        oldest = min(_embedding_probe_ok_mono.items(), key=lambda kv: kv[1])[0]
        _embedding_probe_ok_mono.pop(oldest, None)


def _embedding_probe_signature(connection: RuntimeConnection, *, model: str, api_base: str | None) -> str:
    """Stable key for probe skip — must change when embedding endpoint or model identity changes."""
    ab = (api_base or '').strip()
    conn_emb = (getattr(connection, 'embeddings_base_url', None) or '').strip()
    return f'{connection.provider}\0{model}\0{ab}\0{conn_emb}'


def _mean_l2_normalize(vectors: list[list[float]]) -> list[float]:
    """Average embedding vectors and L2-normalize (common pooled-document convention)."""
    if not vectors:
        return []
    dim = len(vectors[0])
    acc = [0.0] * dim
    for v in vectors:
        for i, x in enumerate(v):
            acc[i] += x
    n = float(len(vectors))
    mean = [x / n for x in acc]
    norm = math.sqrt(sum(x * x for x in mean)) or 1.0
    return [x / norm for x in mean]


def _chunk_text_for_embedding(text: str, max_tokens: int) -> list[str]:
    """Split *text* into segments with at most *max_tokens* ``cl100k_base`` tokens each."""
    import tiktoken

    enc = tiktoken.get_encoding('cl100k_base')
    ids = enc.encode(text, disallowed_special=())
    if len(ids) <= max_tokens:
        return [text]
    return [enc.decode(ids[i : i + max_tokens]) for i in range(0, len(ids), max_tokens)]


class ChunkPoolingOpenAIEmbedding(OpenAIEmbedding):
    """``OpenAIEmbedding`` that splits long inputs and mean-pools chunk vectors.

    Local ``llama-server --embedding`` defaults to a small physical batch (``n_ubatch``, often 512). A single
    request above that limit returns HTTP 500. Index nodes can also exceed the server's tokenizer count versus
    LlamaIndex's sentence splitter. Chunking here keeps OpenAI-compatible servers stable.
    """

    _max_chunk_tokens: int = PrivateAttr()

    def __init__(self, max_input_tokens: int | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        cap = int(max_input_tokens) if max_input_tokens is not None else int(NEMO_EMBEDDINGS_MAX_INPUT_TOKENS)
        self._max_chunk_tokens = max(32, cap)

    def _get_query_embedding(self, query: str) -> list[float]:
        norm = query.replace('\n', ' ')
        chunks = _chunk_text_for_embedding(norm, self._max_chunk_tokens)
        if len(chunks) == 1:
            return super()._get_query_embedding(norm)
        vecs = [super()._get_query_embedding(c) for c in chunks]
        return _mean_l2_normalize(vecs)

    async def _aget_query_embedding(self, query: str) -> list[float]:
        norm = query.replace('\n', ' ')
        chunks = _chunk_text_for_embedding(norm, self._max_chunk_tokens)
        if len(chunks) == 1:
            return await super()._aget_query_embedding(norm)
        vecs = [await super()._aget_query_embedding(c) for c in chunks]
        return _mean_l2_normalize(vecs)

    def _get_text_embedding(self, text: str) -> list[float]:
        norm = text.replace('\n', ' ')
        chunks = _chunk_text_for_embedding(norm, self._max_chunk_tokens)
        if len(chunks) == 1:
            return super()._get_text_embedding(text)
        vecs = [super()._get_text_embedding(c) for c in chunks]
        return _mean_l2_normalize(vecs)

    async def _aget_text_embedding(self, text: str) -> list[float]:
        norm = text.replace('\n', ' ')
        chunks = _chunk_text_for_embedding(norm, self._max_chunk_tokens)
        if len(chunks) == 1:
            return await super()._aget_text_embedding(text)
        vecs = [await super()._aget_text_embedding(c) for c in chunks]
        return _mean_l2_normalize(vecs)

    def _get_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        return [self._get_text_embedding(t) for t in texts]

    async def _aget_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        return [await self._aget_text_embedding(t) for t in texts]


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
    """Construct a token-capped ``OpenAIEmbedding`` wrapper from *connection* settings, or ``(None, error_message)``.

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

    model = resolve_embedding_model_id(connection)
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

    probe_key = _embedding_probe_signature(connection, model=model, api_base=api_base)
    now = time.monotonic()
    _prune_embedding_probe_cache(now)
    probe_hit = _embedding_probe_ok_mono.get(probe_key)
    skip_probe = probe_hit is not None and (now - probe_hit) < _EMBEDDING_PROBE_TTL_SEC

    try:
        embed = ChunkPoolingOpenAIEmbedding(**kwargs)
        if not skip_probe:
            embed.get_query_embedding('nemo')
            _embedding_probe_ok_mono[probe_key] = time.monotonic()
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
