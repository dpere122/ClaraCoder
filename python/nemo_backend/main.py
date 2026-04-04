"""ASGI application entry: FastAPI app construction and route mounting.

Run with uvicorn::

    uvicorn nemo_backend.main:app --host 127.0.0.1 --port 5123

Or use the repo-level :file:`python/server.py` shim (same port) for Electron.
"""

from __future__ import annotations

from fastapi import FastAPI

from nemo_backend.routes import router

# Importing the package triggers LangChain compatibility patches in __init__.py.
app = FastAPI(title='Nemo LangChain Backend')
app.include_router(router)
