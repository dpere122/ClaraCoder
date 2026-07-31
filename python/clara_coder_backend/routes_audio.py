"""Audio transcription and text-to-speech routes."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from clara_coder_backend.audio import get_openai_client, transcribe_google_web
from clara_coder_backend.kokoro_tts import synthesize_wav_bytes, validate_voice_name
from clara_coder_backend.schemas import TtsRequest
from clara_coder_backend import state

logger = logging.getLogger('clara.http.routes.audio')

router = APIRouter()

_TTS_SYNTHESIS_LOCK = asyncio.Lock()


@router.post('/transcribe')
async def transcribe(request: Request) -> dict[str, str]:
    """Accept raw WAV bytes, transcribe via configured provider, return { text }."""
    audio_bytes = await request.body()
    if not audio_bytes:
        return {'text': ''}

    provider = state.runtime_config.audio.provider
    if provider == 'disabled':
        raise HTTPException(status_code=400, detail='Audio transcription is disabled in Settings.')

    with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as temp_file:
        temp_file.write(audio_bytes)
        temp_path = temp_file.name

    try:
        if provider == 'google':
            text = await asyncio.to_thread(transcribe_google_web, temp_path)
            return {'text': text}
        if provider == 'openai':
            client = get_openai_client()
            with open(temp_path, 'rb') as audio_file:
                try:
                    transcript = client.audio.transcriptions.create(
                        file=audio_file, model=state.runtime_config.audio.model
                    )
                except Exception as exc:
                    logger.warning('OpenAI transcription failed: %s', exc)
                    raise HTTPException(
                        status_code=502, detail=f'Transcription failed: {exc}'
                    ) from exc
            return {'text': getattr(transcript, 'text', '') or ''}
        raise HTTPException(status_code=500, detail=f'Unsupported audio provider: {provider}')
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


@router.post('/tts')
async def tts(http_request: Request, request: TtsRequest) -> StreamingResponse:
    """Synthesize speech with local Kokoro TTS and stream WAV audio bytes."""
    try:
        validate_voice_name(request.voice)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async with _TTS_SYNTHESIS_LOCK:
        if await http_request.is_disconnected():
            return StreamingResponse(
                iter([]),
                media_type='audio/wav',
                headers={'Cache-Control': 'no-store'},
            )

        loop = asyncio.get_running_loop()
        try:
            wav = await loop.run_in_executor(
                None,
                lambda: synthesize_wav_bytes(request.text, request.voice, request.speed),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.warning('Kokoro TTS failed: %s', exc)
            raise HTTPException(status_code=503, detail=f'TTS synthesis failed: {exc}') from exc

    chunk_size = 65_536

    async def wav_iter() -> AsyncIterator[bytes]:
        for i in range(0, len(wav), chunk_size):
            yield wav[i : i + chunk_size]

    return StreamingResponse(
        wav_iter(),
        media_type='audio/wav',
        headers={'Cache-Control': 'no-store'},
    )
