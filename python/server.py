"""Launch script for the Clara Coder Python backend.

The Electron main process spawns this file so the import path includes the
``python/`` directory and the ``clara_coder_backend`` package resolves correctly.
"""

from __future__ import annotations
import uvicorn

from clara_coder_backend.main import app

if __name__ == '__main__':

    uvicorn.run(app, host='127.0.0.1', port=5123)
