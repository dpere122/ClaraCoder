"""Normalize chat user turns: plain text and/or OpenAI-style multimodal content blocks."""

from __future__ import annotations

from typing import Any


def effective_user_message_content(
    message: str,
    structured_content: list[dict[str, Any]] | None,
) -> str | list[dict[str, Any]]:
    """Build ``HumanMessage`` content: string, or a list of provider-style blocks.

    When *structured_content* is set, blocks are copied shallowly. If *message* is non-empty
    and no block already carries ``type: text`` with non-empty text, a text block is prepended.
    """
    sc = structured_content if structured_content else None
    raw_msg = message or ''
    if not sc:
        return raw_msg
    blocks: list[dict[str, Any]] = [dict(b) for b in sc]
    text = raw_msg.strip()
    has_text_block = any(
        isinstance(b, dict)
        and str(b.get('type') or '').lower() == 'text'
        and str(b.get('text', '')).strip()
        for b in blocks
    )
    if text and not has_text_block:
        blocks.insert(0, {'type': 'text', 'text': raw_msg})
    return blocks


def validate_user_turn_not_empty(content: str | list[dict[str, Any]]) -> None:
    """Raise ``ValueError`` if the turn would be empty for the model."""
    if isinstance(content, str):
        if not content.strip():
            raise ValueError('Provide non-empty message and/or structured_content')
        return
    if not content:
        raise ValueError('structured_content must not be empty')
