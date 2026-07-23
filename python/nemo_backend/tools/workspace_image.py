"""Workspace image loading for vision-capable models (e.g. Qwen3.5-27B)."""

from __future__ import annotations

import base64
import io
import logging
import mimetypes
import os
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from langchain_core.tools import tool
from PIL import Image, UnidentifiedImageError

from nemo_backend.state import current_session_id, get_session
from nemo_backend.tools.tool_conventions import RELATIVE_PATH, describe
from nemo_backend.tools.workspace import get_active_workspace_root, normalize_relative_path

logger = logging.getLogger('nemo.tools.workspace_image')

READ_WORKSPACE_IMAGE_NAME = 'read_workspace_image'

IMAGE_SUFFIXES: frozenset[str] = frozenset(
    {
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp',
        '.bmp',
    }
)

_DEFAULT_MAX_IMAGE_BYTES = 15 * 1024 * 1024


@dataclass(frozen=True)
class VisionImagePayload:
    relative_path: str
    mime_type: str
    width: int
    height: int
    size_bytes: int
    data_url: str
    focus: str


pending_vision_image_payload: ContextVar[VisionImagePayload | None] = ContextVar(
    'pending_vision_image_payload',
    default=None,
)


def _max_image_bytes() -> int:
    raw = os.getenv('NEMO_MAX_WORKSPACE_IMAGE_BYTES', '').strip()
    if raw.isdigit():
        v = int(raw)
        if v > 0:
            return v
    return _DEFAULT_MAX_IMAGE_BYTES


def _mime_for_path(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed and guessed.startswith('image/'):
        return guessed
    suffix = path.suffix.lower()
    fallback = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
    }
    return fallback.get(suffix, 'application/octet-stream')


def _format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f'{size_bytes} B'
    if size_bytes < 1024 * 1024:
        return f'{size_bytes / 1024:.1f} KB'
    return f'{size_bytes / (1024 * 1024):.1f} MB'


def vision_payload_from_data_url(
    data_url: str,
    *,
    relative_path: str,
    focus: str = '',
) -> VisionImagePayload | None:
    """Build a vision payload from an inline ``data:...;base64,...`` URL."""
    raw = (data_url or '').strip()
    if not raw.startswith('data:'):
        return None
    try:
        header, encoded = raw.split(',', 1)
    except ValueError:
        return None
    mime = header[5:].split(';', 1)[0].strip().lower() or 'application/octet-stream'
    if not mime.startswith('image/'):
        return None
    try:
        data = base64.standard_b64decode(encoded, validate=True)
    except (ValueError, OSError):
        return None
    max_bytes = _max_image_bytes()
    if len(data) > max_bytes:
        return None
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            width, height = im.size
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    rel_display = (relative_path or 'attached-image').replace('\\', '/')
    return VisionImagePayload(
        relative_path=rel_display,
        mime_type=mime,
        width=width,
        height=height,
        size_bytes=len(data),
        data_url=raw,
        focus=(focus or '').strip(),
    )


def load_workspace_image(relative_path: str, *, focus: str = '') -> tuple[str, VisionImagePayload | None]:
    """Read a workspace image and prepare a vision payload for middleware injection."""
    rel = (relative_path or '').strip()
    if not rel:
        return 'Tool note: provide a workspace-relative image path (e.g. `assets/logo.png`).', None

    if not current_session_id.get():
        return 'Tool error: no active session.', None

    try:
        root = get_active_workspace_root()
        target = normalize_relative_path(root, rel)
    except ValueError as exc:
        return f'Tool note: {exc}', None

    rel_display = rel.replace('\\', '/')
    suffix = target.suffix.lower()
    if suffix not in IMAGE_SUFFIXES:
        supported = ', '.join(sorted(IMAGE_SUFFIXES))
        return (
            f'Tool note: `{rel_display}` is not a supported image type (suffix `{suffix or "(none)"}`). '
            f'Supported: {supported}.'
        ), None

    if not target.exists():
        return (
            f'Tool note: `{rel_display}` is not on the workspace disk yet. '
            'Use `list_workspace_directory` to locate image files under the workspace root.'
        ), None
    if not target.is_file():
        return (
            f'Tool note: `{rel_display}` exists but is not a regular file. '
            'Use `list_workspace_directory` to inspect directories.'
        ), None

    try:
        data = target.read_bytes()
    except OSError as exc:
        logger.warning('read_workspace_image failed for %s: %s', rel_display, exc)
        return f'Tool error: could not read `{rel_display}` ({exc}).', None

    max_bytes = _max_image_bytes()
    if len(data) > max_bytes:
        return (
            f'Tool note: `{rel_display}` is {_format_size(len(data))}; '
            f'maximum allowed is {_format_size(max_bytes)}. '
            'Use a smaller image or set `NEMO_MAX_WORKSPACE_IMAGE_BYTES`.'
        ), None

    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            width, height = im.size
            fmt = (im.format or suffix.lstrip('.') or 'png').lower()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        return f'Tool note: `{rel_display}` is not a readable image ({exc}).', None

    mime = _mime_for_path(target)
    if mime == 'application/octet-stream':
        mime = f'image/{fmt}'

    encoded = base64.standard_b64encode(data).decode('ascii')
    data_url = f'data:{mime};base64,{encoded}'
    payload = VisionImagePayload(
        relative_path=rel_display,
        mime_type=mime,
        width=width,
        height=height,
        size_bytes=len(data),
        data_url=data_url,
        focus=(focus or '').strip(),
    )
    summary = (
        f'Loaded image: {rel_display}\n'
        f'Type: {mime}\n'
        f'Size: {width}x{height} px, {_format_size(len(data))}\n'
        'The image is attached in the next vision turn for analysis.'
    )
    if payload.focus:
        summary += f'\nFocus: {payload.focus}'
    return summary, payload


@tool(READ_WORKSPACE_IMAGE_NAME, description=describe(
        'Load a workspace image into vision context for description, OCR, or UI/diagram analysis. '
        'Requires a vision-capable model (e.g. Qwen3.5-27B with the Qwen optimization preset).',
        when='PNG/JPEG/GIF/WebP/BMP under the workspace (screenshots, mockups, diagrams, photos).',
        not_='text files (use `read_workspace_file`); PDFs (use `read_workspace_file` text extraction).',
        shape=f'`relative_path` {RELATIVE_PATH} (e.g. `docs/architecture.png`); optional `focus` steers what to inspect.',
    ))
def read_workspace_image(
    relative_path: Annotated[str, 'workspace-relative POSIX path'],
    focus: str = '',
) -> str:

    summary, payload = load_workspace_image(relative_path, focus=focus)
    if payload is not None:
        pending_vision_image_payload.set(payload)
    return summary
