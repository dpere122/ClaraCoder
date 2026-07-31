"""Inject chat-attached images into vision turns (same pipeline as ``read_workspace_image``)."""

from __future__ import annotations

import re
from typing import Any

from clara_coder_backend.tools.workspace_image import load_workspace_image, vision_payload_from_data_url
from clara_coder_backend.middleware.vision_tool_middleware import vision_human_content_for_payload

ATTACHED_IMAGE_PREFIX = 'Attached image: '
CHAT_ATTACHMENT_VISION_SOURCE = 'chat attachment'
_ATTACHED_IMAGE_PATH_SEARCH = re.compile(
    r'Attached image:\s*(?P<path>.+?)\s*\(use read_workspace_image',
    re.IGNORECASE,
)


def attached_image_paths_from_text(text: str) -> list[str]:
    """Extract workspace-relative image paths from one or more attachment hint lines."""
    return [match.group('path').strip() for match in _ATTACHED_IMAGE_PATH_SEARCH.finditer(text or '')]


def attached_image_path_from_text(text: str) -> str | None:
    """Return the first attached-image path embedded in *text* (may follow a session preamble)."""
    paths = attached_image_paths_from_text(text)
    return paths[0] if paths else None


def _image_url_from_block(block: dict[str, Any]) -> str | None:
    if str(block.get('type') or '').lower() != 'image_url':
        return None
    image_url = block.get('image_url')
    if not isinstance(image_url, dict):
        return None
    url = image_url.get('url')
    if isinstance(url, str) and url.strip():
        return url.strip()
    return None


def _dedupe_preserve_order(paths: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for path in paths:
        key = path.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def prepare_chat_attachment_vision_turn(
    user_content: str | list[dict[str, Any]],
) -> str | list[dict[str, Any]]:
    """Load chat-attached workspace images and append vision analysis blocks to the user turn.

    The renderer keeps ``image_url`` data URLs for UI display only. The backend loads images from
    the workspace using the ``Attached image:`` hint lines so large base64 payloads are not posted
    to ``/chat/stream``.
    """
    if isinstance(user_content, str):
        return user_content

    attached_paths: list[str] = []
    inline_image_urls: list[str] = []
    model_blocks: list[dict[str, Any]] = []

    for block in user_content:
        if not isinstance(block, dict):
            continue
        copy = dict(block)
        block_type = str(copy.get('type') or '').lower()
        if block_type == 'text':
            text = str(copy.get('text') or '')
            attached_paths.extend(attached_image_paths_from_text(text))
            model_blocks.append(copy)
            continue
        url = _image_url_from_block(copy)
        if url:
            inline_image_urls.append(url)
            continue
        model_blocks.append(copy)

    paths = _dedupe_preserve_order(attached_paths)
    vision_blocks: list[dict[str, Any]] = []
    for path in paths:
        _summary, payload = load_workspace_image(path)
        if payload is None:
            continue
        vision_blocks.extend(
            vision_human_content_for_payload(
                payload,
                source=CHAT_ATTACHMENT_VISION_SOURCE,
            )
        )

    if not vision_blocks and inline_image_urls:
        for index, url in enumerate(inline_image_urls):
            rel_path = paths[index] if index < len(paths) else f'attached-image-{index + 1}'
            payload = vision_payload_from_data_url(url, relative_path=rel_path)
            if payload is None:
                model_blocks.append({'type': 'image_url', 'image_url': {'url': url}})
                continue
            vision_blocks.extend(
                vision_human_content_for_payload(
                    payload,
                    source=CHAT_ATTACHMENT_VISION_SOURCE,
                )
            )

    if not vision_blocks:
        return user_content

    if not model_blocks:
        return user_content

    return [*model_blocks, *vision_blocks]
