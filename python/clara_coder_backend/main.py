"""ASGI application entry: FastAPI app construction and route mounting.

Run with uvicorn::

    uvicorn clara_coder_backend.main:app --host 127.0.0.1 --port 5123

Or use the repo-level :file:`python/server.py` shim (same port) for Electron.
"""

from __future__ import annotations

import hmac
import logging
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from clara_coder_backend.logging.app_logging import configure_logging
from clara_coder_backend.config import env_clara
from clara_coder_backend.session.checkpointing import init_graph_checkpointing, shutdown_graph_checkpointing
from clara_coder_backend.lsp.manager import shutdown_all_lsp_managers
import clara_coder_backend.staging.staging_test_overlay  # noqa: F401 — registers LSP overlay hooks
from clara_coder_backend.routes.audio import router as audio_router
from clara_coder_backend.routes.build_plan import router as build_plan_router
from clara_coder_backend.routes.chat import router as chat_router
from clara_coder_backend.routes.checkpoint import router as checkpoint_router
from clara_coder_backend.routes.conversation_title import router as conversation_title_router
from clara_coder_backend.routes.deps import router as deps_router
from clara_coder_backend.routes.log import router as log_router
from clara_coder_backend.routes.lsp import router as lsp_router
from clara_coder_backend.routes.runtime import router as runtime_router
from clara_coder_backend.routes.session import router as session_router

_raw_log = env_clara('CLARA_LOG_DIR', '').strip()
configure_logging(Path(_raw_log) if _raw_log else None)

_logger = logging.getLogger('clara.main')

# Health is the only unauthenticated route (Electron probes + sidecar marker echo).
_AUTH_EXEMPT_PATHS = frozenset({'/health'})

# Default CORS allowlist: loopback (dev UI), file://, and Electron app:// only.
_DEFAULT_ALLOWED_ORIGINS = (
    'http://127.0.0.1',
    'http://localhost',
    'http://127.0.0.1:4200',
    'http://localhost:4200',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'file://',
    'null',
    'app://.',
)


def _allowed_cors_origins() -> list[str]:
    raw = os.getenv('CLARA_ALLOWED_ORIGINS', '').strip()
    if not raw:
        return list(_DEFAULT_ALLOWED_ORIGINS)
    return [part.strip() for part in raw.split(',') if part.strip()]


class SidecarBearerAuthMiddleware(BaseHTTPMiddleware):
    """Require ``Authorization: Bearer <CLARA_SIDECAR_TOKEN>`` on every route except ``/health``.

    When the env token is unset/empty (pytest / bare uvicorn), auth is skipped so local
    tests keep working. Electron always injects a random token at spawn.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # CORS preflight has no Authorization header; let CORSMiddleware answer it.
        if request.method == 'OPTIONS':
            return await call_next(request)

        path = request.url.path.rstrip('/') or '/'
        if path in _AUTH_EXEMPT_PATHS:
            return await call_next(request)

        expected = os.getenv('CLARA_SIDECAR_TOKEN', '') or ''
        if not expected:
            return await call_next(request)

        auth = request.headers.get('authorization') or ''
        scheme, _, credential = auth.partition(' ')
        provided = credential.strip() if scheme.lower() == 'bearer' else ''
        if not provided or not hmac.compare_digest(provided, expected):
            return JSONResponse({'detail': 'Unauthorized'}, status_code=401)
        return await call_next(request)


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await init_graph_checkpointing()
    yield
    try:
        shutdown_all_lsp_managers()
    except Exception:
        _logger.exception('LSP manager shutdown failed during app lifespan cleanup')
    await shutdown_graph_checkpointing()


app = FastAPI(title='Clara Coder LangChain Backend', lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_cors_origins(),
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)
app.add_middleware(SidecarBearerAuthMiddleware)
app.include_router(runtime_router)
app.include_router(deps_router)
app.include_router(session_router)
app.include_router(chat_router)
app.include_router(conversation_title_router)
app.include_router(audio_router)
app.include_router(lsp_router)
app.include_router(log_router)
app.include_router(checkpoint_router)
app.include_router(build_plan_router)
