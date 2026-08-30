"""Pydantic models for HTTP JSON bodies.

Field names match the TypeScript client where noted (camelCase) so the Electron
app can POST without extra mapping.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator

from clara_coder_backend.config import DEFAULT_TRANSCRIBE_MODEL, DEFAULT_WHISPER_MODEL


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
    #: Electron user-message id for this turn (conversation timeline / file journal).
    user_message_id: str = Field(
        default='',
        validation_alias=AliasChoices('user_message_id', 'userMessageId'),
    )
    #: Composer run mode: ``agent`` (ReAct) or ``plan`` (plan-and-execute orchestrator).
    composer_mode: Literal['agent', 'plan'] = Field(
        default='agent',
        validation_alias=AliasChoices('composer_mode', 'composerMode'),
    )
    #: When True, assistant replies are spoken aloud. Mood-tag prompt guidance is added only for openai-compatible TTS.
    speech_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices('speech_enabled', 'speechEnabled'),
    )
    #: TTS backend for this turn (``kokoro`` | ``openai-compatible``). Independent of the LLM provider.
    tts_provider: Literal['kokoro', 'openai-compatible'] = Field(
        default='kokoro',
        validation_alias=AliasChoices('tts_provider', 'ttsProvider'),
    )

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
        from clara_coder_backend.session.chat_input import effective_user_message_content, validate_user_turn_not_empty

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
    staged_transfer_request_id: str = Field(
        default='',
        validation_alias=AliasChoices('staged_transfer_request_id', 'stagedTransferRequestId'),
    )
    staged_transfer_path: str = Field(
        default='',
        validation_alias=AliasChoices('staged_transfer_path', 'stagedTransferPath'),
    )
    #: When set with a pending plan-confirm request, approve or cancel before execution begins.
    plan_confirm_action: Literal['confirm', 'cancel'] | None = Field(
        default=None,
        validation_alias=AliasChoices('plan_confirm_action', 'planConfirmAction'),
    )
    plan_confirm_request_id: str = Field(
        default='',
        validation_alias=AliasChoices('plan_confirm_request_id', 'planConfirmRequestId'),
    )


class QuestionAnswer(BaseModel):
    """One answer in a question-card HITL response."""

    question_id: str = Field(
        default='',
        validation_alias=AliasChoices('question_id', 'questionId'),
    )
    option_id: str = Field(
        default='',
        validation_alias=AliasChoices('option_id', 'optionId'),
    )
    other_text: str = Field(
        default='',
        validation_alias=AliasChoices('other_text', 'otherText'),
    )


class AgentQuestionAnswersRequest(BaseModel):
    """Body for POST /chat/agent-question-answers: resolve a plan-mode question card."""

    session_id: str
    request_id: str = Field(default='', validation_alias=AliasChoices('request_id', 'requestId'))
    action: Literal['submit', 'cancel'] = 'submit'
    answers: list[QuestionAnswer] = Field(default_factory=list)


class AbortRequest(BaseModel):
    """Body for POST /chat/abort: cancel the in-flight stream for a session."""

    session_id: str


class BackgroundCommandTerminalClosedRequest(BaseModel):
    """Body for POST /chat/background-command-terminal-closed: user closed a run_command tab."""

    session_id: str
    command_id: str = Field(default='', validation_alias=AliasChoices('command_id', 'commandId'))


class BuildPlanCancelRequest(BaseModel):
    """Body for POST /build-plan/cancel: delete plan file and abort in-flight stream."""

    session_id: str
    plan_id: str = Field(default='', validation_alias=AliasChoices('plan_id', 'planId'))


class LoadRequest(BaseModel):
    """Replace a session's history with the given messages (e.g. after reload).

    User rows may use legacy ``content`` (string or multimodal list) or chat-shaped
    ``message`` + ``structured_content`` / ``structuredContent`` (normalized server-side).
    Load clears outer LangGraph checkpoints so SQLite history is authoritative next turn.
    """

    session_id: str
    #: Each item should include ``role`` and either ``content`` or ``message`` / structured fields.
    messages: list[dict[str, Any]]


class ClearRequest(BaseModel):
    """Reset or dispose a session (``/clear`` keeps an empty entry; ``/dispose`` removes it)."""

    session_id: str


class SuggestConversationTitleRequest(BaseModel):
    """Body for POST /conversation/suggest-title: derive a short title from session history."""

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
    python_interpreter_id: str = Field(
        default='',
        validation_alias=AliasChoices('python_interpreter_id', 'pythonInterpreterId'),
    )
    bootstrap_python_env: bool = Field(
        default=False,
        validation_alias=AliasChoices('bootstrap_python_env', 'bootstrapPythonEnv'),
    )
    skip_env_bootstrap: bool = Field(
        default=False,
        validation_alias=AliasChoices('skip_env_bootstrap', 'skipEnvBootstrap'),
    )
    workspace_system_prompt: str = Field(
        default='',
        validation_alias=AliasChoices('workspace_system_prompt', 'workspaceSystemPrompt'),
    )


class WorkspaceSystemPromptRequest(BaseModel):
    """Update only the managed workspace system-prompt text for a session."""

    session_id: str
    workspace_system_prompt: str = Field(
        default='',
        validation_alias=AliasChoices('workspace_system_prompt', 'workspaceSystemPrompt'),
    )


class PythonInterpreterSelectRequest(BaseModel):
    """Apply a discovered Python interpreter for LSP and workspace tools."""

    session_id: str
    interpreter_id: str = Field(validation_alias=AliasChoices('interpreter_id', 'interpreterId'))


class TtsRequest(BaseModel):
    """Body for POST /tts: text, Kokoro voice id, and speech speed."""

    text: str
    voice: str = Field(default='af_heart', min_length=2, max_length=48)
    speed: float = Field(
        default=1.0,
        ge=0.5,
        le=2.0,
        validation_alias=AliasChoices('speed', 'speechSpeed'),
    )

    @field_validator('text')
    @classmethod
    def _tts_text_nonempty(cls, v: str) -> str:
        if not (v or '').strip():
            raise ValueError('text must not be empty')
        return v


class ChatTemplateReasoningCapsRequest(BaseModel):
    """Live llama-server Jinja scan (Electron ``GET /props``), not a persisted setting."""

    enableThinking: bool = False
    reasoningEffortValues: list[str] | None = None


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
    parallelToolCalls: bool = True
    optimizationPreset: Literal['generic', 'qwen', 'gemma'] = 'generic'
    maxOutputTokens: int = Field(default=0, ge=0, le=200_000)
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
    embeddingsConfigured: bool = Field(
        default=False,
        validation_alias=AliasChoices('embeddingsConfigured', 'embeddings_configured'),
    )
    contextWindowTokens: int = Field(
        default=0,
        ge=0,
        le=10_000_000,
        validation_alias=AliasChoices('contextWindowTokens', 'context_window_tokens'),
    )
    chatTemplateReasoning: ChatTemplateReasoningCapsRequest | None = Field(
        default=None,
        validation_alias=AliasChoices('chatTemplateReasoning', 'chat_template_reasoning'),
    )

    @field_validator('optimizationPreset', mode='before')
    @classmethod
    def _legacy_optimization_preset(cls, v: object) -> object:
        if isinstance(v, str) and v.strip().lower() == 'capable':
            return 'generic'
        return v

    @field_validator('architectureHint', mode='before')
    @classmethod
    def _legacy_architecture_hint(cls, v: object) -> object:
        if isinstance(v, str) and v.strip().lower() == 'moe':
            return 'auto'
        return v


class RuntimeAudioRequest(BaseModel):
    """Transcription provider and credentials from the app settings."""

    provider: Literal['openai', 'disabled', 'whisper'] = 'whisper'
    baseUrl: str = ''
    model: str = ''
    apiKey: str = ''
    customModelsDir: str = ''

    @model_validator(mode='after')
    def _default_model_for_provider(self) -> RuntimeAudioRequest:
        if (self.model or '').strip():
            return self
        if self.provider == 'whisper':
            self.model = DEFAULT_WHISPER_MODEL
        else:
            self.model = DEFAULT_TRANSCRIBE_MODEL
        return self

    @field_validator('provider', mode='before')
    @classmethod
    def _normalize_audio_provider(cls, v: object) -> object:
        """Keep unknown persisted providers from 422-ing the whole runtime-config (LLM URLs included)."""
        if isinstance(v, str):
            s = v.strip().lower()
            if s in ('openai', 'disabled', 'whisper'):
                return s
            return 'disabled'
        return v


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
    allowStagingOverlayCommands: bool = Field(
        default=False,
        validation_alias=AliasChoices('allowStagingOverlayCommands', 'allow_staging_overlay_commands'),
    )

    commandLineExplainStep: bool = Field(
        default=False,
        validation_alias=AliasChoices('commandLineExplainStep', 'command_line_explain_step'),
    )

    exposeAllWorkspaceFiles: bool = Field(
        default=False,
        validation_alias=AliasChoices('exposeAllWorkspaceFiles', 'expose_all_workspace_files'),
    )

    allowWebAccess: bool = Field(
        default=False,
        validation_alias=AliasChoices('allowWebAccess', 'allow_web_access'),
    )

    searxngBaseUrl: str = Field(
        default='',
        validation_alias=AliasChoices('searxngBaseUrl', 'searxng_base_url'),
    )

    extraUserPath: str = Field(
        default='',
        validation_alias=AliasChoices('extraUserPath', 'extra_user_path'),
    )

    enableAgentFormatters: bool = Field(
        default=False,
        validation_alias=AliasChoices('enableAgentFormatters', 'enable_agent_formatters'),
    )

    @field_validator('allowStagingOverlayCommands', mode='before')
    @classmethod
    def _normalize_allow_overlay(cls, v: Any) -> Any:
        return _coerce_boolish(v)

    @field_validator('commandLineExplainStep', mode='before')
    @classmethod
    def _normalize_command_line_explain_step(cls, v: Any) -> Any:
        return _coerce_boolish(v)

    @field_validator('exposeAllWorkspaceFiles', mode='before')
    @classmethod
    def _normalize_expose_all(cls, v: Any) -> Any:
        return _coerce_boolish(v)

    @field_validator('allowWebAccess', mode='before')
    @classmethod
    def _normalize_allow_web(cls, v: Any) -> Any:
        return _coerce_boolish(v)

    @field_validator('enableAgentFormatters', mode='before')
    @classmethod
    def _normalize_enable_agent_formatters(cls, v: Any) -> Any:
        return _coerce_boolish(v)

    @field_validator('searxngBaseUrl', mode='before')
    @classmethod
    def _normalize_searxng_base_url(cls, v: Any) -> Any:
        if v is None:
            return ''
        return str(v).strip().rstrip('/')

    @field_validator('extraUserPath', mode='before')
    @classmethod
    def _normalize_extra_user_path(cls, v: Any) -> Any:
        if v is None:
            return ''
        return str(v).strip()


class RuntimeContextCompressionRequest(BaseModel):
    """LangGraph checkpoint compaction settings from Settings → Tools."""

    enabled: bool = False
    triggerRatio: float = Field(default=0.70, ge=0.5, le=0.95)
    targetRatio: float = Field(default=0.55, ge=0.4, le=0.90)
    protectTailMessages: int = Field(default=24, ge=8, le=100)
    recentToolBodyMaxChars: int = Field(default=2000, ge=200, le=20_000)
    oldToolBodyMaxChars: int = Field(default=400, ge=100, le=10_000)
    systemReserveRatio: float = Field(default=0.25, ge=0.1, le=0.5)

    @field_validator('enabled', mode='before')
    @classmethod
    def _normalize_enabled(cls, v: Any) -> Any:
        return _coerce_boolish(v)


class RuntimeConfigRequest(BaseModel):
    """Full settings payload from the UI; replaces in-memory runtime_config."""

    activeConnectionId: str
    connections: list[RuntimeConnectionRequest]
    audio: RuntimeAudioRequest
    host: RuntimeHostRequest | None = None
    tools: RuntimeToolsRequest | None = None
    contextCompression: RuntimeContextCompressionRequest | None = None
    huggingFaceToken: str = ''


class LogLevelRequest(BaseModel):
    """Body for POST /logs/level — matches UI ``HealthMonitorConfig.logLevel``."""

    level: Literal['debug', 'info', 'warning', 'error']


class LogIngestRequest(BaseModel):
    """Body for POST /logs/ingest (Electron main → unified log)."""

    level: str = 'INFO'
    logger: str = 'nemo.electron.main'
    message: str
    source: str = 'electron'
