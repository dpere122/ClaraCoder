"""ASGI application entry: FastAPI app construction and route mounting.

Run with uvicorn::

    uvicorn clara_coder_backend.main:app --host 127.0.0.1 --port 5123

Or use the repo-level :file:`python/server.py` shim for Electron (it reads
``CLARA_PYTHON_PORT`` from the environment, defaulting to 5123).
"""

from __future__ import annotations

import hmac
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

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
from clara_coder_backend.routes.mcp import router as mcp_router
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


def _scope_header(scope: Scope, name: str) -> str:
    """Read one HTTP header from an ASGI scope (header names are lower-case bytes)."""
    target = name.lower().encode('latin-1')
    for key, value in scope.get('headers') or ():
        if key == target:
            return value.decode('latin-1')
    return ''


class SidecarBearerAuthMiddleware:
    """Require ``Authorization: Bearer <CLARA_SIDECAR_TOKEN>`` on every route except ``/health``.

    Pure ASGI (not Starlette ``BaseHTTPMiddleware``): long-lived SSE (``/chat/stream``,
    ``/logs/stream``) must not serialize other HTTP requests. ``BaseHTTPMiddleware`` wraps
    ``call_next`` in a task group that can hold the rest of the sidecar until the stream
    ends, so Electron ``POST /clear`` never got response headers (undici
    ``UND_ERR_HEADERS_TIMEOUT``) and New Conversation stayed on the loading spinner.

    Auth is fail-closed: an empty ``CLARA_SIDECAR_TOKEN`` rejects requests unless
    ``CLARA_SIDECAR_AUTH_OPTIONAL=1`` is set (pytest / bare uvicorn). Electron always
    injects a random token at spawn. CORS preflight (OPTIONS with
    ``Access-Control-Request-Method`` and an allowlisted ``Origin``) skips auth so
    CORSMiddleware can answer; bare OPTIONS does not.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return

        method = str(scope.get('method') or 'GET')
        if method == 'OPTIONS':
            origin = _scope_header(scope, 'origin')
            acrm = _scope_header(scope, 'access-control-request-method')
            if acrm and origin in _allowed_cors_origins():
                await self.app(scope, receive, send)
                return

        path = str(scope.get('path') or '/').rstrip('/') or '/'
        if path in _AUTH_EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        expected = os.getenv('CLARA_SIDECAR_TOKEN', '') or ''
        if not expected:
            # Fail closed unless explicitly opted out for local/test runs.
            if (os.getenv('CLARA_SIDECAR_AUTH_OPTIONAL', '') or '').strip() == '1':
                await self.app(scope, receive, send)
                return
            await JSONResponse({'detail': 'Unauthorized'}, status_code=401)(scope, receive, send)
            return

        auth = _scope_header(scope, 'authorization')
        scheme, _, credential = auth.partition(' ')
        provided = credential.strip() if scheme.lower() == 'bearer' else ''
        if (
            not provided
            or len(provided) != len(expected)
            or not hmac.compare_digest(provided, expected)
        ):
            await JSONResponse({'detail': 'Unauthorized'}, status_code=401)(scope, receive, send)
            return
        await self.app(scope, receive, send)


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await init_graph_checkpointing()
    yield
    try:
        shutdown_all_lsp_managers()
    except Exception:
        _logger.exception('LSP manager shutdown failed during app lifespan cleanup')
    try:
        from clara_coder_backend.mcp.manager import shutdown_mcp

        await shutdown_mcp()
    except Exception:
        _logger.exception('MCP manager shutdown failed during app lifespan cleanup')
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
app.include_router(mcp_router)
app.include_router(deps_router)
app.include_router(session_router)
app.include_router(chat_router)
app.include_router(conversation_title_router)
app.include_router(audio_router)
app.include_router(lsp_router)
app.include_router(log_router)
app.include_router(checkpoint_router)
app.include_router(build_plan_router)
