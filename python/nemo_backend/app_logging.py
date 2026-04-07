"""Central logging: rotating file, ring buffer for live UI, level control."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from collections import deque
from itertools import count
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

LOG_FILE_NAME = 'nemo-app.log'
MAX_BACKUP_BYTES = 8 * 1024 * 1024
BACKUP_COUNT = 4
RING_MAX = 4000

_seq = count(1)
_buffer_lock = threading.Lock()
_ring: deque[dict[str, Any]] = deque(maxlen=RING_MAX)
_configured = False


def _record_to_dict(record: logging.LogRecord) -> dict[str, Any]:
    extra = getattr(record, 'log_source', None)
    return {
        'seq': next(_seq),
        'ts': int(record.created * 1000),
        'level': record.levelname,
        'logger': record.name,
        'message': record.getMessage(),
        'source': extra if isinstance(extra, str) else 'backend',
    }


class RingBufferHandler(logging.Handler):
    """Thread-safe ring buffer of recent records for /logs/recent and SSE."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            payload = _record_to_dict(record)
            with _buffer_lock:
                _ring.append(payload)
        except Exception:
            self.handleError(record)


def get_records_since(seq: int, limit: int = 500) -> list[dict[str, Any]]:
    with _buffer_lock:
        items = [r for r in _ring if r['seq'] > seq]
    if len(items) > limit:
        items = items[-limit:]
    return items


def get_recent_records(limit: int = 200) -> list[dict[str, Any]]:
    with _buffer_lock:
        return list(_ring)[-limit:]


def set_nemo_log_level(name: str) -> None:
    level = getattr(logging, name.upper(), logging.INFO)
    logging.getLogger('nemo').setLevel(level)
    # Keep access noise down unless debug
    uv_err = logging.getLogger('uvicorn.error')
    uv_acc = logging.getLogger('uvicorn.access')
    if level <= logging.DEBUG:
        uv_err.setLevel(logging.DEBUG)
        uv_acc.setLevel(logging.INFO)
    else:
        uv_err.setLevel(logging.WARNING)
        uv_acc.setLevel(logging.WARNING)


def configure_logging(log_dir: Path | None = None) -> Path:
    """Attach file + ring handlers to ``nemo`` subtree. Idempotent."""
    global _configured
    if _configured:
        return log_dir or Path(os.environ.get('NEMO_LOG_DIR', tempfile.gettempdir()))

    if log_dir is None:
        raw = os.environ.get('NEMO_LOG_DIR', '').strip()
        log_dir = Path(raw) if raw else Path(tempfile.gettempdir()) / 'nemo-wrapper-logs'
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / LOG_FILE_NAME

    nemo = logging.getLogger('nemo')
    nemo.setLevel(logging.INFO)
    nemo.propagate = False

    fmt = logging.Formatter(
        '%(asctime)s %(levelname)s [%(name)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    )

    fh = RotatingFileHandler(
        log_path,
        maxBytes=MAX_BACKUP_BYTES,
        backupCount=BACKUP_COUNT,
        encoding='utf-8',
    )
    fh.setFormatter(fmt)
    fh.setLevel(logging.DEBUG)

    ring = RingBufferHandler()
    ring.setLevel(logging.DEBUG)

    nemo.addHandler(fh)
    nemo.addHandler(ring)

    _configured = True
    nemo.info('Logging initialized (dir=%s)', log_dir)
    return log_dir


def reset_logging_handlers() -> None:
    """Close file handlers (e.g. tests on Windows before deleting temp log dir)."""
    global _configured
    nemo = logging.getLogger('nemo')
    for h in list(nemo.handlers):
        try:
            h.close()
        except Exception:
            pass
        nemo.removeHandler(h)
    _configured = False
    with _buffer_lock:
        _ring.clear()


def log_ingest(level: str, logger_name: str, message: str, source: str = 'electron') -> None:
    """Log a line from Electron (or other clients) into the same pipeline."""
    lg = logging.getLogger(logger_name if logger_name.startswith('nemo.') else f'nemo.{logger_name}')
    lvl = getattr(logging, level.upper(), logging.INFO)
    lg.log(lvl, '%s', message, extra={'log_source': source})
