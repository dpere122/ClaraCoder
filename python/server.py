"""Launch script for the Clara Coder Python backend.

The Electron main process spawns this file so the import path includes the
``python/`` directory and the ``clara_coder_backend`` package resolves correctly.

The listen port is passed via ``CLARA_PYTHON_PORT`` (Electron sets it per
environment: 5124 in dev, 5123 packaged) and defaults to 5123 so the script
also works when run standalone.
"""

from __future__ import annotations

import os

import uvicorn

from clara_coder_backend.main import app

if __name__ == '__main__':
    port = int(os.getenv('CLARA_PYTHON_PORT', '5123'))
    uvicorn.run(app, host='127.0.0.1', port=port)
