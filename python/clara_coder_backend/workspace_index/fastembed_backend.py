"""In-process FastEmbed/ONNX CPU embeddings — the primary embedding backend."""

from __future__ import annotations

import gc
import logging
import os
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.bridge.pydantic import PrivateAttr

from clara_coder_backend.config import (
    CLARA_FASTEMBED_CACHE_DIR,
    CLARA_FASTEMBED_IDLE_UNLOAD_SEC,
    CLARA_FASTEMBED_MODEL,
    CLARA_FASTEMBED_THREADS,
)
from clara_coder_backend.runtime.deps.paths import get_runtime_dir

logger = logging.getLogger('clara.workspace_index.fastembed')

_NOMIC_QUERY_PREFIX = 'search_query: '
_NOMIC_DOC_PREFIX = 'search_document: '

# FastEmbed's own default. INT8 ONNX ~67 MB, 384-dim, 512-token context.
# nomic-ai/nomic-embed-text-v1.5 is ~520 MB unquantized with 8192-token attention;
# ONNX CPU activations climb into multiple GB during a workspace index.
DEFAULT_FASTEMBED_MODEL = 'BAAI/bge-small-en-v1.5'

# ONNX Runtime's default CPU arena + one thread per core balloons RAM while embedding a
# large workspace (multi-GB and it does not shrink). Cap threads and disable the arena.
# ``CLARA_FASTEMBED_THREADS`` > 0 overrides the auto cap (still bounded by cpu_count).
_ONNX_INTRA_OP_THREADS = (
    max(1, min(CLARA_FASTEMBED_THREADS, os.cpu_count() or 1))
    if CLARA_FASTEMBED_THREADS > 0
    else min(4, os.cpu_count() or 1)
)
# Sequences per ONNX run. Attention activations scale with batch x seq_len^2, so at the
# 512-token cap a batch of 16 peaked ~445 MB above the loaded model; 8 halves that.
_ONNX_INFER_BATCH = 8
# Texts per LlamaIndex embedding call. Each call is sorted longest-first before being cut
# into ONNX batches, so a batch pads to similar lengths instead of to one long outlier.
_EMBED_CALL_BATCH = 64

_engine_lock = threading.Lock()
_engine: Any = None
_engine_key: tuple[str, str] | None = None
# (model, cache) pairs that loaded successfully; after an idle unload they reload lazily.
_loaded_once: set[tuple[str, str]] = set()
_engine_active = 0
_engine_last_used = 0.0
_reaper: threading.Thread | None = None

# Process-wide embeddings load status: 'idle' | 'loading' | 'ready' | 'error' | 'disabled'.
_embed_status: str = 'idle'
_embed_status_lock = threading.Lock()


def get_embed_status() -> str:
    """Current CPU embeddings load status for the status-bar indicator."""
    with _embed_status_lock:
        return _embed_status


def _set_embed_status(status: str) -> None:
    global _embed_status
    with _embed_status_lock:
        _embed_status = status


def fastembed_cache_dir() -> Path:
    """Directory for FastEmbed ONNX weights (``CLARA_FASTEMBED_CACHE_DIR`` or runtime cache)."""
    raw = (CLARA_FASTEMBED_CACHE_DIR or '').strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return get_runtime_dir() / 'embeddings' / 'fastembed'


def fastembed_model_id() -> str:
    return (CLARA_FASTEMBED_MODEL or '').strip() or DEFAULT_FASTEMBED_MODEL


def reset_fastembed_engine_for_tests() -> None:
    """Drop the process-wide TextEmbedding singleton (unit tests only)."""
    global _engine, _engine_key, _engine_active
    with _engine_lock:
        _engine = None
        _engine_key = None
        _engine_active = 0
        _loaded_once.clear()
    _set_embed_status('idle')


def _is_nomic_embed_text(model_name: str) -> bool:
    return 'nomic-embed-text' in (model_name or '').lower()


def _cache_has_model(cache_dir: Path, model_name: str) -> bool:
    if not cache_dir.is_dir():
        return False
    slug = 'models--' + model_name.replace('/', '--')
    hub = cache_dir / slug
    if hub.is_dir():
        return True
    try:
        return any(cache_dir.iterdir())
    except OSError:
        return False


def _as_float_list(vec: Any) -> list[float]:
    if vec is None:
        return []
    if hasattr(vec, 'tolist'):
        return vec.tolist()
    return [float(x) for x in vec]


def _load_text_embedding(model_name: str, cache_dir: Path) -> Any:
    try:
        import onnxruntime
        from fastembed import TextEmbedding
    except ImportError as exc:
        raise RuntimeError(
            'CPU embeddings require fastembed and onnxruntime in the Clara Python runtime. '
            'Reinstall Clara Coder, or pip install fastembed onnxruntime.'
        ) from exc

    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = _cache_has_model(cache_dir, model_name)
    if cached:
        logger.info(
            'Loading CPU FastEmbed model=%s from cache dir=%s',
            model_name,
            cache_dir,
        )
    else:
        logger.info(
            'Downloading CPU FastEmbed model=%s into cache dir=%s (first use)',
            model_name,
            cache_dir,
        )
    logger.debug('onnxruntime version=%s', getattr(onnxruntime, '__version__', 'unknown'))
    engine = TextEmbedding(
        model_name=model_name,
        cache_dir=str(cache_dir),
        threads=_ONNX_INTRA_OP_THREADS,
        providers=['CPUExecutionProvider'],
        cuda=False,
        enable_cpu_mem_arena=False,
    )
    logger.info(
        'CPU FastEmbed model=%s ready cache_dir=%s onnx_threads=%s',
        model_name,
        cache_dir,
        _ONNX_INTRA_OP_THREADS,
    )
    return engine


def get_text_embedding_engine(model_name: str, cache_dir: Path) -> Any:
    """Return a process-wide ``TextEmbedding``, loading it if absent (first use or after an idle unload)."""
    global _engine, _engine_key, _engine_last_used
    key = (model_name, str(cache_dir))
    with _engine_lock:
        _engine_last_used = time.monotonic()
        if _engine is not None and _engine_key == key:
            logger.debug('Reusing CPU FastEmbed engine model=%s cache_dir=%s', model_name, cache_dir)
            _set_embed_status('ready')
            return _engine
        _set_embed_status('loading')
        try:
            _engine = _load_text_embedding(model_name, cache_dir)
            _engine_key = key
            _loaded_once.add(key)
            _set_embed_status('ready')
            _ensure_idle_reaper()
            return _engine
        except Exception:
            _set_embed_status('error')
            raise


@contextmanager
def _leased_engine(model_name: str, cache_dir: Path) -> Iterator[Any]:
    """The engine for one embedding call; the idle reaper never unloads it mid-call."""
    global _engine_active, _engine_last_used
    engine = get_text_embedding_engine(model_name, cache_dir)
    with _engine_lock:
        _engine_active += 1
    try:
        yield engine
    finally:
        with _engine_lock:
            _engine_active -= 1
            _engine_last_used = time.monotonic()


def _ensure_idle_reaper() -> None:
    """Start the idle-unload thread (caller holds ``_engine_lock``)."""
    global _reaper
    if CLARA_FASTEMBED_IDLE_UNLOAD_SEC <= 0 or (_reaper is not None and _reaper.is_alive()):
        return
    _reaper = threading.Thread(target=_idle_reaper_loop, name='clara-fastembed-idle-unload', daemon=True)
    _reaper.start()


def unload_idle_engine(now: float | None = None) -> bool:
    """Drop the engine if it has been unused for ``CLARA_FASTEMBED_IDLE_UNLOAD_SEC``; True when unloaded."""
    global _engine, _engine_key
    idle_limit = CLARA_FASTEMBED_IDLE_UNLOAD_SEC
    with _engine_lock:
        if _engine is None or idle_limit <= 0 or _engine_active:
            return False
        idle = (time.monotonic() if now is None else now) - _engine_last_used
        if idle < idle_limit:
            return False
        model_name = _engine_key[0] if _engine_key else ''
        _engine = None
        _engine_key = None
        _set_embed_status('idle')
    # ONNX Runtime frees the session's buffers once the last reference is gone.
    gc.collect()
    logger.info('Unloaded idle CPU FastEmbed model=%s after %.0fs unused (reloads on next use)', model_name, idle)
    return True


def _idle_reaper_loop() -> None:
    global _reaper
    while True:
        time.sleep(max(5.0, min(60.0, CLARA_FASTEMBED_IDLE_UNLOAD_SEC / 4)))
        unload_idle_engine()
        with _engine_lock:
            if _engine is None:
                # Exit while nothing is loaded; the next load starts a fresh reaper.
                _reaper = None
                return


def _prefix_query(model_name: str, text: str) -> str:
    if _is_nomic_embed_text(model_name) and not text.startswith(_NOMIC_QUERY_PREFIX):
        return f'{_NOMIC_QUERY_PREFIX}{text}'
    return text


def _prefix_document(model_name: str, text: str) -> str:
    if _is_nomic_embed_text(model_name) and not text.startswith(_NOMIC_DOC_PREFIX):
        return f'{_NOMIC_DOC_PREFIX}{text}'
    return text


def _embed_longest_first(embed: Callable[..., Iterable[Any]], texts: list[str], **infer: Any) -> list[list[float]]:
    """Embed *texts* sorted by length (less padding per ONNX batch); results in input order."""
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]), reverse=True)
    out: list[list[float]] = [[] for _ in texts]
    for i, vec in zip(order, embed([texts[i] for i in order], **infer)):
        out[i] = _as_float_list(vec)
    return out


class FastEmbedEmbedding(BaseEmbedding):
    """LlamaIndex embedding wrapper around FastEmbed ``TextEmbedding``.

    Without a pinned *engine* it borrows the process-wide one per call, so cached
    indexes holding this wrapper don't keep the ONNX model resident after an idle unload.
    """

    _engine: Any = PrivateAttr(default=None)
    _cache_dir: Path | None = PrivateAttr(default=None)

    def __init__(
        self,
        *,
        model_name: str,
        engine: Any = None,
        cache_dir: Path | None = None,
        embed_batch_size: int = _EMBED_CALL_BATCH,
        **kwargs: Any,
    ) -> None:
        super().__init__(model_name=model_name, embed_batch_size=embed_batch_size, **kwargs)
        self._engine = engine
        self._cache_dir = cache_dir

    @contextmanager
    def _engine_for_call(self) -> Iterator[Any]:
        if self._engine is not None:
            yield self._engine
            return
        with _leased_engine(self.model_name, self._cache_dir or fastembed_cache_dir()) as engine:
            yield engine

    def _infer_kwargs(self) -> dict[str, Any]:
        return {'batch_size': _ONNX_INFER_BATCH, 'parallel': None}

    def _embed_queries(self, queries: list[str]) -> list[list[float]]:
        with self._engine_for_call() as engine:
            query_embed = getattr(engine, 'query_embed', None)
            if callable(query_embed):
                return [_as_float_list(v) for v in query_embed(queries, **self._infer_kwargs())]
            prefixed = [_prefix_query(self.model_name, q) for q in queries]
            return [_as_float_list(v) for v in engine.embed(prefixed, **self._infer_kwargs())]

    def _embed_documents(self, texts: list[str]) -> list[list[float]]:
        infer = self._infer_kwargs()
        with self._engine_for_call() as engine:
            passage_embed = getattr(engine, 'passage_embed', None)
            if callable(passage_embed):
                return _embed_longest_first(passage_embed, texts, **infer)
            if callable(getattr(engine, 'query_embed', None)):
                # FastEmbed registry already applies document prefixes on ``embed``.
                return _embed_longest_first(engine.embed, texts, **infer)
            prefixed = [_prefix_document(self.model_name, t) for t in texts]
            return _embed_longest_first(engine.embed, prefixed, **infer)

    def _get_query_embedding(self, query: str) -> list[float]:
        norm = (query or '').replace('\n', ' ')
        vecs = self._embed_queries([norm])
        return vecs[0] if vecs else []

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return self._get_query_embedding(query)

    def _get_text_embedding(self, text: str) -> list[float]:
        norm = (text or '').replace('\n', ' ')
        vecs = self._embed_documents([norm])
        return vecs[0] if vecs else []

    async def _aget_text_embedding(self, text: str) -> list[float]:
        return self._get_text_embedding(text)

    def _get_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        norms = [(t or '').replace('\n', ' ') for t in texts]
        return self._embed_documents(norms)

    async def _aget_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        return self._get_text_embeddings(texts)


def build_fastembed_embedding() -> tuple[BaseEmbedding | None, str]:
    """CPU FastEmbed embeddings wrapper, or ``(None, error)``.

    The first build loads the model so a broken install surfaces here. Once a model
    has loaded, an idle unload leaves it unloaded until a call actually embeds text
    (a background job that finds the index current never pays for a reload).
    """
    model_name = fastembed_model_id()
    cache_dir = fastembed_cache_dir()
    try:
        with _engine_lock:
            loaded_before = (model_name, str(cache_dir)) in _loaded_once
        if not loaded_before:
            get_text_embedding_engine(model_name, cache_dir)
        embed = FastEmbedEmbedding(model_name=model_name, cache_dir=cache_dir)
    except Exception as exc:
        logger.warning('CPU FastEmbed load failed model=%s: %s', model_name, exc, exc_info=True)
        _set_embed_status('error')
        return (
            None,
            f'Semantic index unavailable (CPU FastEmbed {type(exc).__name__}: {exc}). '
            'Install fastembed/onnxruntime in the Clara Python runtime (reinstall Clara Coder).',
        )
    logger.info('Using CPU FastEmbed embeddings (primary) model=%s cache_dir=%s', model_name, cache_dir)
    return embed, ''
