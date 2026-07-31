"""Normalize OpenAI-compatible TTS base URLs pasted from Settings."""

from __future__ import annotations

import re


def normalize_openai_tts_base_url(base_url: str) -> str:
    """Strip trailing slashes and common ``/v1/audio/...`` suffixes if pasted by mistake."""
    url = (base_url or '').strip()
    while url.endswith('/'):
        url = url[:-1]
    url = re.sub(r'/v1/audio/speech/?$', '', url, flags=re.IGNORECASE)
    url = re.sub(r'/v1/audio/?$', '', url, flags=re.IGNORECASE)
    if url.lower().endswith('/v1'):
        url = url[:-3]
        while url.endswith('/'):
            url = url[:-1]
    return url
