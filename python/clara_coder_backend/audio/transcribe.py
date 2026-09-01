"""Speech-to-text helpers and OpenAI client construction for audio features.

Transcription routes choose the provider from :data:`~clara_coder_backend.session.state.runtime_config`.
"""

from __future__ import annotations

import logging
import os
from threading import Lock
from typing import Any

from fastapi import HTTPException
from openai import OpenAI

from clara_coder_backend.config import DEFAULT_WHISPER_MODEL
from clara_coder_backend.runtime.deps.paths import whisper_models_dir
from clara_coder_backend.session.state import require_openai_api_key, runtime_config

logger = logging.getLogger('clara.audio')

_MODEL_LOCK = Lock()
_INFERENCE_LOCK = Lock()
_CACHED_KEY: tuple[str, str] | None = None
_CACHED_MODEL: Any = None

_WHISPER_MISSING = (
    'Whisper STT is not installed. Open Dependencies and download “Whisper STT”.'
)


def _model_not_downloaded_message(model_name: str) -> str:
    return (
        f'Whisper model {model_name!r} is not downloaded. '
        'Open Dependencies and download that size.'
    )


def reset_whisper_model_cache() -> None:
    """Drop the cached WhisperModel instance (tests / size change)."""
    global _CACHED_KEY, _CACHED_MODEL
    with _MODEL_LOCK:
        _CACHED_KEY = None
        _CACHED_MODEL = None


def transcribe_whisper(wav_path: str) -> str:
    """Transcribe a WAV file with in-process faster-whisper (CPU).

    Weights must already exist under ``{customModelsDir}/whisper`` (no Hub fetch).
    Raises ``RuntimeError`` when the optional package or the selected size is missing.
    """
    audio = runtime_config.audio
    model_name = (audio.model or DEFAULT_WHISPER_MODEL).strip() or DEFAULT_WHISPER_MODEL
    download_root = whisper_models_dir(audio.custom_models_dir)
    model = _get_whisper_model(model_name, str(download_root))
    with _INFERENCE_LOCK:
        segments, _info = model.transcribe(
            wav_path,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return ''.join(seg.text for seg in segments).strip()


def _looks_like_missing_weights(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name in ('LocalEntryNotFoundError', 'EntryNotFoundError'):
        return True
    msg = str(exc).lower()
    return (
        'local_files_only' in msg
        or 'not found' in msg
        or 'offline' in msg
        or 'cannot find' in msg
    )


def _get_whisper_model(model_name: str, download_root: str) -> Any:
    global _CACHED_KEY, _CACHED_MODEL
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(_WHISPER_MISSING) from exc

    key = (model_name, download_root)
    with _MODEL_LOCK:
        if _CACHED_KEY == key and _CACHED_MODEL is not None:
            return _CACHED_MODEL
        logger.info(
            'Loading faster-whisper model=%r download_root=%r device=cpu compute_type=int8 local_files_only',
            model_name,
            download_root,
        )
        try:
            loaded = WhisperModel(
                model_name,
                device='cpu',
                compute_type='int8',
                download_root=download_root,
                local_files_only=True,
            )
        except Exception as exc:
            if _looks_like_missing_weights(exc):
                raise RuntimeError(_model_not_downloaded_message(model_name)) from exc
            raise
        _CACHED_KEY = key
        _CACHED_MODEL = loaded
        return loaded


def get_openai_client() -> OpenAI:
    """OpenAI SDK client configured from runtime audio settings (transcription)."""
    audio = runtime_config.audio
    if audio.provider == 'disabled':
        raise HTTPException(status_code=400, detail='Audio transcription is disabled in Settings.')
    if audio.provider == 'whisper':
        raise HTTPException(status_code=500, detail='OpenAI client is not used for Whisper transcription.')
    if audio.provider != 'openai':
        raise HTTPException(status_code=500, detail='Only OpenAI audio transcription is currently supported.')

    api_key = audio.api_key or os.getenv('OPENAI_API_KEY', '')
    require_openai_api_key(api_key, 'OpenAI audio')

    kwargs: dict[str, str] = {'api_key': api_key}
    if audio.base_url:
        kwargs['base_url'] = audio.base_url
    return OpenAI(**kwargs)
