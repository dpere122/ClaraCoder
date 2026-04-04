"""HTTP route handlers for the FastAPI application.

Endpoints mirror what the Electron renderer expects: health, session lifecycle,
workspace sync, streaming chat, transcription, TTS, and runtime settings.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from typing import AsyncIterator

import edge_tts
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from nemo_backend.agent import stream_agent_reply
from nemo_backend.audio import get_openai_client, transcribe_google_web
from nemo_backend.domain import (
    RuntimeAudioConfig,
    RuntimeConfig,
    RuntimeConnection,
    RuntimeHostConfig,
    SessionState,
)
from nemo_backend.schemas import (
    ChatRequest,
    ClearRequest,
    LoadRequest,
    RuntimeConfigRequest,
    TtsRequest,
    WorkspaceContextRequest,
)
from nemo_backend import state

router = APIRouter()


@router.get('/health')
async def health() -> dict[str, str]:
    """Liveness probe: confirms the process is up and reports active model metadata."""
    connection = state.get_active_connection()
    return {
        'status': 'ok',
        'provider': connection.provider,
        'model': connection.model,
    }


@router.post('/runtime-config')
async def set_runtime_config(request: RuntimeConfigRequest) -> dict[str, bool]:
    """Replace LLM connections, transcription settings, and host metadata from the UI."""
    connections = [
        RuntimeConnection(
            id=item.id,
            name=item.name,
            provider=item.provider,
            base_url=item.baseUrl,
            model=item.model,
            api_key=item.apiKey,
            reasoning_effort=(item.reasoningEffort or '').strip(),
        )
        for item in request.connections
    ]
    if not connections:
        raise HTTPException(status_code=400, detail='At least one LLM connection is required.')

    active_connection_id = request.activeConnectionId
    if not any(connection.id == active_connection_id for connection in connections):
        active_connection_id = connections[0].id

    state.runtime_config = RuntimeConfig(
        active_connection_id=active_connection_id,
        connections=connections,
        audio=RuntimeAudioConfig(
            provider=request.audio.provider,
            base_url=request.audio.baseUrl,
            model=request.audio.model,
            api_key=request.audio.apiKey,
        ),
        host=RuntimeHostConfig(
            platform=request.host.platform if request.host else '',
            release=request.host.release if request.host else '',
            arch=request.host.arch if request.host else '',
            version=request.host.version if request.host else '',
            label=request.host.label if request.host else '',
        ),
    )
    return {'ok': True}


@router.post('/clear')
async def clear_session(request: ClearRequest) -> dict[str, bool]:
    """Drop chat history for a session id (fresh SessionState)."""
    state.sessions[request.session_id] = SessionState()
    return {'ok': True}


@router.post('/load')
async def load_session(request: LoadRequest) -> dict[str, bool]:
    """Bulk-restore messages into a session (typically after app restart)."""
    sess = state.get_session(request.session_id)
    sess.history = [
        {
            'role': item.get('role', 'user'),
            'content': item.get('content', ''),
        }
        for item in request.messages
        if item.get('content')
    ]
    return {'ok': True}


@router.post('/workspace-context')
async def set_workspace_context(request: WorkspaceContextRequest) -> dict[str, bool]:
    """Attach or update workspace path and renderer-provided tree/state for a session."""
    sess = state.get_session(request.session_id)
    sess.workspace_path = request.workspace_path
    sess.workspace_context = request.workspace_context
    sess.workspace_state = request.workspace_state
    return {'ok': True}


@router.post('/chat/stream')
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    """Stream assistant reply as Server-Sent Events (status + chunk + [DONE])."""
    generator = stream_agent_reply(request.session_id, request.message, request.apply_mode)
    return StreamingResponse(generator, media_type='text/event-stream')


@router.post('/transcribe')
async def transcribe(request: Request) -> dict[str, str]:
    """Accept raw WAV bytes, transcribe via configured provider, return { text }."""
    audio_bytes = await request.body()
    if not audio_bytes:
        return {'text': ''}

    provider = state.runtime_config.audio.provider
    if provider == 'disabled':
        raise HTTPException(status_code=400, detail='Audio transcription is disabled in Settings.')

    # Write body to a temp file; Google and OpenAI APIs expect a path or file handle.
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
