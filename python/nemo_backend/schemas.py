"""Pydantic models for HTTP JSON bodies.

Field names match the TypeScript client where noted (camelCase) so the Electron
app can POST without extra mapping.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from nemo_backend.config import DEFAULT_TRANSCRIBE_MODEL


class ChatRequest(BaseModel):
    """Body for POST /chat/stream: one user message in an existing session."""

    session_id: str
    message: str
    #: When False, Editor mode is off: workspace write/edit tools are not bound (read/search only).
    apply_mode: bool = True
    #: When True, successful edit proposals are written to disk in the backend and no diff-review pause is used.
    auto_apply_mode: bool = False


class SessionAutoApplyRequest(BaseModel):
    """Body for POST /session/auto-apply: update the live auto-apply flag (e.g. user toggled mid-stream)."""

    session_id: str
    auto_apply_mode: bool = False


class AgentContinueRequest(BaseModel):
    """Resume an agent stream that is waiting after a diff or approval/confirmation step."""

    session_id: str
    note: str = ''
    #: When set with a pending delete request, perform or cancel the delete before resuming.
    delete_action: Literal['confirm', 'cancel'] | None = None
    delete_request_id: str = ''
    #: When set with a pending copy request, perform or cancel the copy before resuming.
    copy_action: Literal['confirm', 'cancel'] | None = None
    copy_request_id: str = ''
    #: When set with a pending generic command request, perform or cancel it before resuming.
    accept_command_action: Literal['confirm', 'cancel'] | None = None
    accept_command_request_id: str = ''


class AbortRequest(BaseModel):
    """Body for POST /chat/abort: cancel the in-flight stream for a session."""

    session_id: str


class LoadRequest(BaseModel):
    """Replace a session's history with the given messages (e.g. after reload)."""

    session_id: str
    messages: list[dict[str, str]]


class ClearRequest(BaseModel):
    """Reset a session to empty history (workspace fields cleared implicitly)."""

    session_id: str


class WorkspaceContextRequest(BaseModel):
    """Sync workspace path and renderer-generated tree for a session."""

    session_id: str
    workspace_path: str
    workspace_context: str


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
    temperature: float = Field(default=0.0, ge=0.0, le=1.0)
    parallelToolCalls: bool = False
    optimizationPreset: Literal['generic', 'qwen', 'capable'] = 'generic'
    maxOutputTokens: int = Field(default=0, ge=0, le=200_000)
    planRetryAttemptsCount: int = Field(default=2, ge=0, le=20)


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


class RuntimeToolsRequest(BaseModel):
    """Workspace tool limits and edit surface from the desktop app (Settings → Tools)."""

    editToolsStrict: bool = False
    maxFileReadLines: int = Field(default=400, ge=50, le=2000)
    maxSearchResults: int = Field(default=40, ge=1, le=200)
    defaultWorkspaceEncoding: str = 'utf-8'
    defaultWorkspaceNewline: Literal['lf', 'crlf', 'preserve'] = 'lf'


class RuntimeConfigRequest(BaseModel):
    """Full settings payload from the UI; replaces in-memory runtime_config."""

    activeConnectionId: str
    connections: list[RuntimeConnectionRequest]
    audio: RuntimeAudioRequest
    host: RuntimeHostRequest | None = None
    tools: RuntimeToolsRequest | None = None


class LogLevelRequest(BaseModel):
    """Body for POST /logs/level — matches UI ``HealthMonitorConfig.logLevel``."""

    level: Literal['debug', 'info', 'warning', 'error']


class LogIngestRequest(BaseModel):
    """Body for POST /logs/ingest (Electron main → unified log)."""

    level: str = 'INFO'
    logger: str = 'nemo.electron.main'
    message: str
    source: str = 'electron'
