"""In-process FastEmbed/ONNX CPU embeddings — the primary embedding backend."""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any

from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.bridge.pydantic import PrivateAttr

from clara_coder_backend.config import CLARA_FASTEMBED_CACHE_DIR, CLARA_FASTEMBED_MODEL
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
_ONNX_INTRA_OP_THREADS = min(4, os.cpu_count() or 1)
_EMBED_INFER_BATCH = 16

_engine_lock = threading.Lock()
_engine: Any = None
_engine_key: tuple[str, str] | None = None

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
    global _engine, _engine_key
    with _engine_lock:
        _engine = None
        _engine_key = None
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
        vec = vec.tolist()
    return [float(x) for x in vec]


def _load_text_embedding(model_name: str, cache_dir: Path) -> Any:
    try:
        import onnxruntime
        from fastembed import TextEmbedding
    except ImportError as exc:
        raise RuntimeError(
            'CPU embeddings require fastembed and onnxruntime in the Clara Python runtime. '
            'Open File → Dependencies and update Python runtime, or pip install fastembed onnxruntime.'
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
    """Return a process-wide ``TextEmbedding``, loading once per (model, cache) pair."""
    global _engine, _engine_key
    key = (model_name, str(cache_dir))
    with _engine_lock:
        if _engine is not None and _engine_key == key:
            logger.debug('Reusing CPU FastEmbed engine model=%s cache_dir=%s', model_name, cache_dir)
            _set_embed_status('ready')
            return _engine
        _set_embed_status('loading')
        try:
            _engine = _load_text_embedding(model_name, cache_dir)
            _engine_key = key
            _set_embed_status('ready')
            return _engine
        except Exception:
            _set_embed_status('error')
            raise


def _prefix_query(model_name: str, text: str) -> str:
    if _is_nomic_embed_text(model_name) and not text.startswith(_NOMIC_QUERY_PREFIX):
        return f'{_NOMIC_QUERY_PREFIX}{text}'
    return text


def _prefix_document(model_name: str, text: str) -> str:
    if _is_nomic_embed_text(model_name) and not text.startswith(_NOMIC_DOC_PREFIX):
        return f'{_NOMIC_DOC_PREFIX}{text}'
    return text


class FastEmbedEmbedding(BaseEmbedding):
    """LlamaIndex embedding wrapper around FastEmbed ``TextEmbedding``."""

    _engine: Any = PrivateAttr()

    def __init__(self, *, model_name: str, engine: Any, embed_batch_size: int = _EMBED_INFER_BATCH, **kwargs: Any) -> None:
        super().__init__(model_name=model_name, embed_batch_size=embed_batch_size, **kwargs)
        self._engine = engine

    def _infer_kwargs(self) -> dict[str, Any]:
        return {'batch_size': self.embed_batch_size, 'parallel': None}

    def _embed_queries(self, queries: list[str]) -> list[list[float]]:
        engine = self._engine
        query_embed = getattr(engine, 'query_embed', None)
        if callable(query_embed):
            return [_as_float_list(v) for v in query_embed(queries, **self._infer_kwargs())]
        prefixed = [_prefix_query(self.model_name, q) for q in queries]
        return [_as_float_list(v) for v in engine.embed(prefixed, **self._infer_kwargs())]

    def _embed_documents(self, texts: list[str]) -> list[list[float]]:
        engine = self._engine
        passage_embed = getattr(engine, 'passage_embed', None)
        infer = self._infer_kwargs()
        if callable(passage_embed):
            return [_as_float_list(v) for v in passage_embed(texts, **infer)]
        if callable(getattr(engine, 'query_embed', None)):
            # FastEmbed registry already applies document prefixes on ``embed``.
            return [_as_float_list(v) for v in engine.embed(texts, **infer)]
        prefixed = [_prefix_document(self.model_name, t) for t in texts]
        return [_as_float_list(v) for v in engine.embed(prefixed, **infer)]

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
    """Load the pinned CPU FastEmbed model, or return ``(None, error)``."""
    model_name = fastembed_model_id()
    cache_dir = fastembed_cache_dir()
    try:
        engine = get_text_embedding_engine(model_name, cache_dir)
        embed = FastEmbedEmbedding(model_name=model_name, engine=engine)
    except Exception as exc:
        logger.warning('CPU FastEmbed load failed model=%s: %s', model_name, exc, exc_info=True)
        _set_embed_status('error')
        return (
            None,
            f'Semantic index unavailable (CPU FastEmbed {type(exc).__name__}: {exc}). '
            'Install fastembed/onnxruntime in the Clara Python runtime (File → Dependencies).',
        )
    logger.info('Using CPU FastEmbed embeddings (primary) model=%s cache_dir=%s', model_name, cache_dir)
    return embed, ''
