"""Read bounded text from workspace files for indexing."""

from __future__ import annotations

import logging
from pathlib import Path

from pypdf import PdfReader

logger = logging.getLogger('nemo.workspace_index.read')


def read_file_for_index(path: Path, *, max_bytes: int) -> str:
    """Return UTF-8 text (or PDF extraction) capped by *max_bytes* (UTF-8 byte length after decode)."""
    sfx = path.suffix.lower()
    if sfx == '.pdf':
        return _read_pdf_text(path, max_bytes=max_bytes)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        logger.debug('index read skip path=%s err=%s', path, exc)
        return ''
    if len(raw) > max_bytes:
        raw = raw[:max_bytes]
    return raw.decode('utf-8', errors='replace')


def _read_pdf_text(path: Path, *, max_bytes: int) -> str:
    try:
        reader = PdfReader(str(path))
    except Exception as exc:
        logger.debug('index pdf open failed path=%s err=%s', path, exc)
        return ''

    if reader.is_encrypted and reader.decrypt('') == 0:
        return ''

    parts: list[str] = []
    total = 0
    for i, page in enumerate(reader.pages):
        try:
            raw = page.extract_text() or ''
        except Exception as exc:
            raw = f'[page {i + 1} extraction error: {exc}]'
        chunk = f'--- Page {i + 1} ---\n{raw}\n'
        enc = chunk.encode('utf-8', errors='replace')
        if total + len(enc) > max_bytes:
            remain = max_bytes - total
            if remain <= 0:
                break
            parts.append(enc[:remain].decode('utf-8', errors='replace'))
            break
        parts.append(chunk)
        total += len(enc)
    return ''.join(parts)
