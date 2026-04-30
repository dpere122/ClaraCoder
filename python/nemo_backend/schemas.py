"""Pydantic models for HTTP JSON bodies.

Field names match the TypeScript client where noted (camelCase) so the Electron
app can POST without extra mapping.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator

from nemo_backend.config import DEFAULT_TRANSCRIBE_MODEL


class ChatRequest(BaseModel):
    """Body for POST /chat/stream: one user message in an existing session."""

    session_id: str
    #: Plain-text user turn (default). May be combined with ``structured_content`` / ``structuredContent``.
    message: str = ''
    #: OpenAI-style multimodal blocks (``text``, ``image_url``, ``input_audio``, etc.). Sent as ``HumanMessage`` content.
    structured_content: list[dict[str, Any]] | None = Field(
        default=None,
        validation_alias=AliasChoices('structured_content', 'structuredContent'),
    )
    #: When False, Editor mode is off: workspace write/edit tools are not bound (read/search only).
    apply_mode: bool = True
    #: When True, successful edit proposals are written to disk in the backend and no diff-review pause is used.
    auto_apply_mode: bool = False
    #: Optional LangGraph ``checkpoint_id`` to continue or replay from (fork head / time-travel).
    checkpoint_id: str = ''

    @field_validator('structured_content')
    @classmethod
    def _structured_entries_are_objects(cls, v: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
        if not v:
            return v
        for i, item in enumerate(v):
            if not isinstance(item, dict):
                raise ValueError(f'structured_content[{i}] must be a JSON object')
        return v

    @model_validator(mode='after')
    def _user_turn_non_empty(self) -> 'ChatRequest':
        from nemo_backend.chat_input import effective_user_message_content, validate_user_turn_not_empty

        eff = effective_user_message_content(self.message, self.structured_content)
        validate_user_turn_not_empty(eff)
        return self


class CheckpointForkRequest(BaseModel):
    """Fork from a prior checkpoint (LangGraph ``update_state`` / time-travel)."""

    session_id: str
    apply_mode: bool = True
    checkpoint_id: str
    values: dict[str, Any] = Field(default_factory=dict)


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
    #: When set with ``pending_staged_transfer_hitl``, finalize or return the deferred staged→workspace transfer.
    staged_transfer_action: Literal['confirm', 're_review'] | None = Field(
        default=None,
        validation_alias=AliasChoices('staged_transfer_action', 'stagedTransferAction'),
    )


class AbortRequest(BaseModel):
    """Body for POST /chat/abort: cancel the in-flight stream for a session."""

    session_id: str


class LoadRequest(BaseModel):
    """Replace a session's history with the given messages (e.g. after reload)."""

    session_id: str
    #: Each item should include ``role`` and ``content`` (string or OpenAI-style multimodal list for user turns).
    messages: list[dict[str, Any]]


class ClearRequest(BaseModel):
    """Reset a session to empty history (workspace fields cleared implicitly)."""

    session_id: str


class WorkspaceFileChangesPayload(BaseModel):
    """Debounced filesystem batch from the Electron workspace watcher (optional)."""

    paths: list[str] = Field(default_factory=list)
    kinds: list[str] = Field(default_factory=list)


class WorkspaceContextRequest(BaseModel):
    """Sync workspace path and renderer-generated tree for a session."""

    session_id: str
    workspace_path: str
    workspace_context: str
    workspace_id: str = Field(default='', validation_alias=AliasChoices('workspace_id', 'workspaceId'))
    workspace_file_changes: WorkspaceFileChangesPayload | None = Field(
        default=None,
        validation_alias=AliasChoices('workspace_file_changes', 'workspaceFileChanges'),
    )


class TtsRequest(BaseModel):
    """Body for POST /tts: text and Edge TTS voice name."""

    text: str
    voice: str


class RuntimeConnectionRequest(BaseModel):
    """One connection entry inside RuntimeConfigRequest."""

    id: str
    name: str
    provider: Literal['openai', 'lmstudio', 'llamacpp']
    baseUrl: str = ''
    model: str
    apiKey: str = ''
    reasoningEffort: str = ''
    temperature: float = Field(default=0.0, ge=0.0, le=1.0)
    parallelToolCalls: bool = False
    optimizationPreset: Literal['generic', 'qwen', 'capable', 'gemma'] = 'generic'
    maxOutputTokens: int = Field(default=0, ge=0, le=200_000)
    planRetryAttemptsCount: int = Field(default=2, ge=0, le=20)
    thinkingMode: Literal['default', 'on', 'off'] = 'default'
    samplingPreset: Literal['provider-default', 'gemma-recommended', 'custom'] = 'provider-default'
    topP: float | None = Field(default=None, ge=0.0, le=1.0)
    topK: int | None = Field(default=None, ge=1, le=256)
    minP: float | None = Field(default=None, ge=0.0, le=1.0)
    presencePenalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    repeatPenalty: float | None = Field(default=None, ge=0.01, le=4.0)
    architectureHint: Literal['auto', 'dense'] = 'auto'
    embeddingsBaseUrl: str = Field(
        default='',
        validation_alias=AliasChoices('embeddingsBaseUrl', 'embeddings_base_url'),
    )
    embeddingsEnabled: bool = Field(
        default=True,
        validation_alias=AliasChoices('embeddingsEnabled', 'embeddings_enabled'),
    )
    embeddingsModel: str = Field(
        default='',
        validation_alias=AliasChoices('embeddingsModel', 'embeddings_model'),
    )

    @field_validator('architectureHint', mode='before')
    @classmethod
    def _legacy_architecture_hint(cls, v: object) -> object:
        if isinstance(v, str) and v.strip().lower() == 'moe':
            return 'auto'
        return v


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


def _coerce_boolish(v: Any) -> Any:
    """Accept true/false strings (hand-edited JSON, proxies) before standard bool validation."""
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ('true', '1', 'yes', 'on'):
            return True
        if s in ('false', '0', 'no', 'off'):
            return False
    return v


class RuntimeToolsRequest(BaseModel):
    """Workspace tool limits and edit surface from the desktop app (Settings → Tools)."""

    editToolsStrict: bool = False
    maxFileReadLines: int = Field(default=400, ge=50, le=2000)
    maxSearchResults: int = Field(default=40, ge=1, le=200)
    defaultWorkspaceEncoding: str = 'utf-8'
    defaultWorkspaceNewline: Literal['lf', 'crlf', 'preserve'] = 'lf'
    orchestratedMode: bool = Field(
        default=False,
        validation_alias=AliasChoices('orchestratedMode', 'orchestrated_mode'),
    )
    outerPhasedCodingCycle: bool = Field(
        default=False,
        validation_alias=AliasChoices('outerPhasedCodingCycle', 'outer_phased_coding_cycle'),
    )
    allowStagingOverlayCommands: bool = Field(
        default=False,
        validation_alias=AliasChoices('allowStagingOverlayCommands', 'allow_staging_overlay_commands'),
    )

    @field_validator('orchestratedMode', mode='before')
    @classmethod
    def _normalize_orchestrated(cls, v: Any) -> Any:
        return _coerce_boolish(v)

    @field_validator('outerPhasedCodingCycle', mode='before')
    @classmethod
    def _normalize_outer_phased(cls, v: Any) -> Any:
        return _coerce_boolish(v)

    @field_validator('allowStagingOverlayCommands', mode='before')
    @classmethod
    def _normalize_allow_overlay(cls, v: Any) -> Any:
        return _coerce_boolish(v)


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
