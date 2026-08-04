"""Local Kokoro-82M text-to-speech (replaces Edge TTS).

Requires optional runtime deps: ``kokoro``, ``soundfile``, ``torch`` (see ``requirements.txt``).
Voice ``lang_code`` is chosen from the voice id prefix per upstream docs:
``a`` American, ``b`` British, ``e`` Spanish.
"""

from __future__ import annotations

import io
import logging
import re
from threading import Lock
from typing import Any

import numpy as np
import soundfile as sf

logger = logging.getLogger('clara.tts.kokoro')

_PIPELINE_CACHE: dict[str, Any] = {}
_PIPELINE_LOCK = Lock()
_INFERENCE_LOCK = Lock()

_VOICE_RE = re.compile(r'^[a-z]{2}_[a-z0-9]{2,40}$')


def _audio_to_float_numpy(audio: object) -> np.ndarray:
    """Normalize Kokoro output (numpy or torch tensor) to 1-D float32 samples."""
    x = audio
    if hasattr(x, 'detach'):
        x = x.detach().cpu().numpy()
    arr = np.asarray(x, dtype=np.float32).reshape(-1)
    return arr


def lang_code_for_voice(voice: str) -> str:
    """Return Kokoro ``lang_code`` for the given voice id.

    ``a`` = American English, ``b`` = British English, ``e`` = Spanish.
    """
    v = (voice or '').strip().lower()
    if v.startswith(('bf_', 'bm_')):
        return 'b'
    if v.startswith(('ef_', 'em_')):
        return 'e'
    return 'a'


def _get_pipeline(lang_code: str) -> Any:
    try:
        from kokoro import KPipeline  # heavy import; load once per lang
    except ImportError as exc:
        raise RuntimeError(
            'Kokoro TTS is not installed. Open File → Dependencies and download “Kokoro TTS”.'
        ) from exc

    with _PIPELINE_LOCK:
        pip = _PIPELINE_CACHE.get(lang_code)
        if pip is None:
            logger.info('Initializing Kokoro KPipeline(lang_code=%r)', lang_code)
            pip = KPipeline(lang_code=lang_code)
            _PIPELINE_CACHE[lang_code] = pip
        return pip


def validate_voice_name(voice: str) -> str:
    v = (voice or '').strip()
    if not _VOICE_RE.match(v):
        raise ValueError(f'Invalid Kokoro voice id: {voice!r}')
    return v


def synthesize_wav_bytes(text: str, voice: str, speed: float) -> bytes:
    """Run Kokoro synchronously; return a complete WAV (PCM_16, mono) byte string."""
    voice = validate_voice_name(voice)
    lang = lang_code_for_voice(voice)
    pipeline = _get_pipeline(lang)
    chunks: list[np.ndarray] = []
    sample_rate = 24_000
    try:
        with _INFERENCE_LOCK:
            generator = pipeline(
                text.strip(),
                voice=voice,
                speed=float(speed),
                split_pattern=r'\n+',
            )
            for _gs, _ps, audio in generator:
                if audio is None:
                    continue
                arr = _audio_to_float_numpy(audio)
                if arr.size == 0:
                    continue
                chunks.append(arr)
    except Exception:
        logger.exception('Kokoro synthesis failed (voice=%s)', voice)
        raise
    if not chunks:
        raise ValueError('No audio generated')
    pcm = np.concatenate(chunks)
    buf = io.BytesIO()
    sf.write(buf, pcm, sample_rate, format='WAV', subtype='PCM_16')
    wav = buf.getvalue()
    logger.info(
        'Kokoro synthesize ok voice=%s lang=%s speed=%s chars=%s bytes=%s',
        voice,
        lang,
        speed,
        len(text.strip()),
        len(wav),
    )
    return wav
