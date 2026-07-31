"""ASGI application entry: FastAPI app construction and route mounting.

Run with uvicorn::

    uvicorn clara_coder_backend.main:app --host 127.0.0.1 --port 5123

Or use the repo-level :file:`python/server.py` shim (same port) for Electron.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from clara_coder_backend.app_logging import configure_logging
from clara_coder_backend.config import env_clara
from clara_coder_backend.checkpointing import init_graph_checkpointing, shutdown_graph_checkpointing
from clara_coder_backend.lsp.manager import shutdown_all_lsp_managers
from clara_coder_backend.log_routes import router as log_router
from clara_coder_backend.routes_lsp import router as lsp_router
from clara_coder_backend.routes import router as runtime_router
from clara_coder_backend.routes_audio import router as audio_router
from clara_coder_backend.routes_chat import router as chat_router
from clara_coder_backend.routes_conversation_title import router as conversation_title_router
from clara_coder_backend.routes_build_plan import router as build_plan_router
from clara_coder_backend.routes_checkpoint import router as checkpoint_router
from clara_coder_backend.routes_session import router as session_router

_raw_log = env_clara('CLARA_LOG_DIR', '').strip()
configure_logging(Path(_raw_log) if _raw_log else None)

_logger = logging.getLogger('clara.main')


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
app.include_router(runtime_router)
app.include_router(session_router)
app.include_router(chat_router)
app.include_router(conversation_title_router)
app.include_router(audio_router)
app.include_router(lsp_router)
app.include_router(log_router)
app.include_router(checkpoint_router)
app.include_router(build_plan_router)
