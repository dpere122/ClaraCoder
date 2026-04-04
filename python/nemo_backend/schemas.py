"""Pydantic models for HTTP JSON bodies.

Field names match the TypeScript client where noted (camelCase) so the Electron
app can POST without extra mapping.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from nemo_backend.config import DEFAULT_TRANSCRIBE_MODEL


class ChatRequest(BaseModel):
    """Body for POST /chat/stream: one user message in an existing session."""

    session_id: str
    message: str
    apply_mode: bool = True


class LoadRequest(BaseModel):
    """Replace a session's history with the given messages (e.g. after reload)."""

    session_id: str
    messages: list[dict[str, str]]


class ClearRequest(BaseModel):
    """Reset a session to empty history (workspace fields cleared implicitly)."""

    session_id: str


class WorkspaceContextRequest(BaseModel):
    """Sync workspace path and renderer-generated tree/state for a session."""

    session_id: str
    workspace_path: str
    workspace_context: str
    workspace_state: str = ''


class TtsRequest(BaseModel):
    """Body for POST /tts: text and Edge TTS voice name."""

    text: str
    voice: str


class RuntimeConnectionRequest(BaseModel):
    """One connection entry inside RuntimeConfigRequest."""

    id: str
    name: str
    provider: Literal['openai', 'lmstudio']
    baseUrl: str = ''
    model: str
    apiKey: str = ''
    reasoningEffort: str = ''


class RuntimeAudioRequest(BaseModel):
    """Transcription provider and credentials from the app settings."""

    provider: Literal['openai', 'disabled', 'google'] = 'openai'
    baseUrl: str = ''
    model: str = DEFAULT_TRANSCRIBE_MODEL
    apiKey: str = ''


class RuntimeHostRequest(BaseModel):
    """Optional host metadata block from the shell process."""

    platform: str = ''
    release: str = ''
    arch: str = ''
    version: str = ''
    label: str = ''


class RuntimeConfigRequest(BaseModel):
    """Full settings payload from the UI; replaces in-memory runtime_config."""

    activeConnectionId: str
    connections: list[RuntimeConnectionRequest]
    audio: RuntimeAudioRequest
    host: RuntimeHostRequest | None = None
