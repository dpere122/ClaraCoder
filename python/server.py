"""Launch script for the Nemo Python backend.

The Electron main process spawns this file so the import path includes the
``python/`` directory and the ``nemo_backend`` package resolves correctly.
"""

from __future__ import annotations

if __name__ == '__main__':
    import uvicorn

    from nemo_backend.main import app

    uvicorn.run(app, host='127.0.0.1', port=5123)
