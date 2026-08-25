"""In-process FastEmbed/ONNX CPU embeddings as the primary embedding backend."""

from __future__ import annotations

import logging
import threading

from llama_index.core.base.embeddings.base import BaseEmbedding

from clara_coder_backend.config import CLARA_EMBEDDINGS_CPU_ENABLED
from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.workspace_index.fastembed_backend import (
    build_fastembed_embedding,
    fastembed_model_id,
    get_text_embedding_engine,
    fastembed_cache_dir,
)

logger = logging.getLogger('clara.workspace_index.embeddings')

_CHAT_EMBEDDING_PROVIDERS = frozenset({'openai', 'lmstudio', 'llamacpp'})
_logged_backend_choice: set[str] = set()
_preload_lock = threading.Lock()
_preloaded_key: str | None = None
_preload_in_flight: str | None = None


def _chat_base_is_placeholder(connection: RuntimeConnection) -> bool:
    """True when managed llama.cpp forwarded a stopped chat server (port 0)."""
    base = (connection.base_url or '').strip().replace('\\', '/')
    return ':0/v1' in base


def chat_connected(connection: RuntimeConnection) -> tuple[bool, str]:
    """Whether a chat model is selected and (for managed llama.cpp) actually running."""
    if connection.provider not in _CHAT_EMBEDDING_PROVIDERS:
        return False, f'Embeddings unavailable: unsupported provider {connection.provider!r}.'
    if not (connection.model or '').strip():
        return False, 'Semantic index skipped: no chat model is selected.'
    if connection.provider == 'llamacpp' and _chat_base_is_placeholder(connection):
        return (
            False,
            'Semantic index skipped: managed llama.cpp chat server is not running.',
        )
    return True, ''


def cpu_embeddings_available(connection: RuntimeConnection) -> tuple[bool, str]:
    """True when in-process FastEmbed/ONNX CPU embeddings should run for *connection*."""
    if not CLARA_EMBEDDINGS_CPU_ENABLED:
        return False, 'CPU embeddings are disabled (CLARA_EMBEDDINGS_CPU_ENABLED).'
    chat_ok, chat_reason = chat_connected(connection)
    if not chat_ok:
        return False, chat_reason
    return True, ''


def _log_backend_once(key: str, message: str, *args: object) -> None:
    if key in _logged_backend_choice:
        logger.debug(message, *args)
        return
    _logged_backend_choice.add(key)
    logger.info(message, *args)


def resolve_embedding_model_id(connection: RuntimeConnection) -> str:
    """Effective embeddings model id (matches :func:`build_embedding_model`)."""
    return fastembed_model_id()


def embeddings_available(connection: RuntimeConnection) -> tuple[bool, str]:
    """Return whether semantic index / embedding calls should run for *connection*."""
    cpu_ok, cpu_reason = cpu_embeddings_available(connection)
    if cpu_ok:
        return True, ''
    return False, cpu_reason


def build_embedding_model(connection: RuntimeConnection) -> tuple[BaseEmbedding | None, str]:
    """Construct CPU FastEmbed embeddings, or ``(None, error_message)``.

    In-process FastEmbed is the primary embedding backend. It activates as soon
    as a chat model is connected — no HTTP embeddings endpoint is used.
    """
    cpu_ok, cpu_reason = cpu_embeddings_available(connection)
    if not cpu_ok:
        logger.info(
            'Semantic index skipped provider=%s chat_model=%s: %s',
            connection.provider,
            (connection.model or '').strip() or '(none)',
            cpu_reason,
        )
        return None, cpu_reason

    model_id = fastembed_model_id()
    _log_backend_once(
        f'cpu\0{connection.provider}\0{model_id}',
        'Using CPU FastEmbed embeddings (primary) provider=%s chat_model=%s embed_model=%s',
        connection.provider,
        (connection.model or '').strip() or '(none)',
        model_id,
    )
    return build_fastembed_embedding()


def preload_embedding_model(connection: RuntimeConnection) -> None:
    """Start loading the CPU FastEmbed ONNX model in a background thread.

    Called as soon as the chat model is connected (``POST /runtime-config``)
    so the model is resident in memory before the first semantic tool call.
    Safe to call repeatedly — only loads once per (model, cache) pair.
    A failed load clears the in-flight guard so a later ``POST /runtime-config`` can retry.
    """
    cpu_ok, _ = cpu_embeddings_available(connection)
    if not cpu_ok:
        return

    model_name = fastembed_model_id()
    cache_dir = fastembed_cache_dir()
    key = f'{model_name}\0{cache_dir}'
    global _preloaded_key, _preload_in_flight
    with _preload_lock:
        if _preloaded_key == key or _preload_in_flight == key:
            return
        _preload_in_flight = key

    def _load() -> None:
        global _preloaded_key, _preload_in_flight
        try:
            get_text_embedding_engine(model_name, cache_dir)
            logger.info('CPU embeddings preloaded model=%s cache_dir=%s', model_name, cache_dir)
            with _preload_lock:
                _preloaded_key = key
        except Exception as exc:
            logger.warning('CPU embeddings preload failed model=%s: %s', model_name, exc, exc_info=True)
        finally:
            with _preload_lock:
                if _preload_in_flight == key:
                    _preload_in_flight = None

    t = threading.Thread(target=_load, name='clara-preload-embeddings', daemon=True)
    t.start()
