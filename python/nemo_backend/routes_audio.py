"""Audio transcription and text-to-speech routes."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from typing import AsyncIterator

import edge_tts
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from nemo_backend.audio import get_openai_client, transcribe_google_web
from nemo_backend.schemas import TtsRequest
from nemo_backend import state

logger = logging.getLogger('nemo.http.routes.audio')

router = APIRouter()


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
async def tts(request: TtsRequest) -> StreamingResponse:
    """Synthesize speech with Edge TTS and stream MPEG audio bytes."""
    communicate = edge_tts.Communicate(request.text, request.voice)

    async def audio_iter() -> AsyncIterator[bytes]:
        async for chunk in communicate.stream():
            if chunk.get('type') == 'audio':
                data = chunk.get('data') or b''
                if data:
                    yield data

    return StreamingResponse(
        audio_iter(),
        media_type='audio/mpeg',
        headers={'Cache-Control': 'no-store'},
    )
