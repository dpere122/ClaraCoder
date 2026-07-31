"""HTTP client for OpenAI-compatible ``/v1/audio/speech`` (WAV)."""

from __future__ import annotations

import logging
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from clara_coder_backend.tts.openai_compatible.base_url import normalize_openai_tts_base_url

logger = logging.getLogger('clara.tts.openai_compatible')

_DEFAULT_MODEL = 'qwen3-tts-custom-voice'


def synthesize_wav_bytes(
    text: str,
    voice: str,
    speed: float,
    *,
    base_url: str,
    api_key: str = '',
    instructions: str = '',
    model: str = _DEFAULT_MODEL,
    timeout_sec: float = 120.0,
) -> bytes:
    """POST to ``{base}/v1/audio/speech`` and return the WAV body."""
    import json

    body_text = (text or '').strip()
    if not body_text:
        raise ValueError('text must not be empty')
    voice_id = (voice or '').strip()
    if not voice_id:
        raise ValueError('voice must not be empty')

    base = normalize_openai_tts_base_url(base_url)
    if not base:
        raise ValueError('base_url is required')

    payload: dict[str, Any] = {
        'input': body_text,
        'voice': voice_id,
        'model': model,
        'response_format': 'wav',
        'speed': float(speed),
    }
    instr = (instructions or '').strip()
    if instr:
        payload['instructions'] = instr

    headers = {'Content-Type': 'application/json'}
    key = (api_key or '').strip()
    if key:
        headers['Authorization'] = f'Bearer {key}'

    req = Request(
        f'{base}/v1/audio/speech',
        data=json.dumps(payload).encode('utf-8'),
        headers=headers,
        method='POST',
    )
    try:
        with urlopen(req, timeout=timeout_sec) as resp:
            data = resp.read()
    except HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')[:240]
        logger.warning('OpenAI-compatible TTS HTTP %s: %s', exc.code, detail)
        raise ValueError(f'TTS HTTP {exc.code}: {detail}') from exc
    except URLError as exc:
        logger.warning('OpenAI-compatible TTS request failed: %s', exc)
        raise ValueError(f'TTS request failed: {exc}') from exc

    if not data:
        raise ValueError('TTS: empty response body')
    return data
