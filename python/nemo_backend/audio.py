"""Speech-to-text helpers and OpenAI client construction for audio features.

Transcription routes choose the provider from :data:`~nemo_backend.state.runtime_config`.
"""

from __future__ import annotations

import os

import speech_recognition as sr
from fastapi import HTTPException
from openai import OpenAI

from nemo_backend.state import require_openai_api_key, runtime_config


def transcribe_google_web(wav_path: str) -> str:
    """Transcribe a WAV file using Google's free web Speech API (no API key).

    Requires network access; audio is sent to Google. Returns empty string on
    unrecognized audio.
    """
    recognizer = sr.Recognizer()
    with sr.AudioFile(wav_path) as source:
        audio_data = recognizer.record(source)
    try:
        return recognizer.recognize_google(audio_data)
    except sr.UnknownValueError:
        return ''
    except sr.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f'Google Speech Recognition request failed: {exc}',
        ) from exc


def get_openai_client() -> OpenAI:
    """OpenAI SDK client configured from runtime audio settings (transcription)."""
    audio = runtime_config.audio
    if audio.provider == 'disabled':
        raise HTTPException(status_code=400, detail='Audio transcription is disabled in Settings.')
    if audio.provider == 'google':
        raise HTTPException(status_code=500, detail='OpenAI client is not used for Google transcription.')
    if audio.provider != 'openai':
        raise HTTPException(status_code=500, detail='Only OpenAI audio transcription is currently supported.')

    api_key = audio.api_key or os.getenv('OPENAI_API_KEY', '')
    require_openai_api_key(api_key, 'OpenAI audio')

    kwargs: dict[str, str] = {'api_key': api_key}
    if audio.base_url:
        kwargs['base_url'] = audio.base_url
    return OpenAI(**kwargs)
