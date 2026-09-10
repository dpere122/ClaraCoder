"""Launch script for the Clara Coder Python backend.

The Electron main process spawns this file so the import path includes the
``python/`` directory and the ``clara_coder_backend`` package resolves correctly.

The listen port is passed via ``CLARA_PYTHON_PORT`` (Electron sets it per
environment: 5124 in dev, 5123 packaged) and defaults to 5123 so the script
also works when run standalone.
"""

from __future__ import annotations

import os

# Must run before anything imports numpy: OpenBLAS allocates a per-thread buffer pool
# sized to the machine's core count at import time (~490 MB committed on 16 cores).
# The sidecar never does numpy-level BLAS work, so a single BLAS thread costs nothing.
# Only OpenBLAS is capped — do NOT set OMP_NUM_THREADS here: Kokoro (torch) and
# faster-whisper (CTranslate2) run in-process on CPU and rely on it for parallelism.
# ``setdefault`` keeps an explicit override from the environment intact.
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')

import uvicorn  # noqa: E402

from clara_coder_backend.main import app  # noqa: E402

if __name__ == '__main__':
    port = int(os.getenv('CLARA_PYTHON_PORT', '5123'))
    uvicorn.run(app, host='127.0.0.1', port=port)
