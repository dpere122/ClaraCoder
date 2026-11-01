"""Pydantic models for HTTP JSON bodies.

Field names match the TypeScript client where noted (camelCase) so the Electron
app can POST without extra mapping.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

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
    #: Auto Run: when True, command / web / MCP tools run without an approval card. Edits never ask (they are
    #: reviewed and reset after the turn).
    auto_apply_mode: bool = False
    #: Composer Admin chip (agent-wide elevated ``run_command`` grant).
    admin_elevation_granted: bool = Field(
        default=False,
        validation_alias=AliasChoices('admin_elevation_granted', 'adminElevationGranted'),
    )
    #: Optional LangGraph ``checkpoint_id`` to continue or replay from (fork head / time-travel).
    checkpoint_id: str = ''
    #: Electron user-message id for this turn (conversation timeline / file journal).
    user_message_id: str = Field(
        default='',
        validation_alias=AliasChoices('user_message_id', 'userMessageId'),
    )
    #: Workspace facts the model should know before this turn, e.g. files the user reset from earlier turns.
    workspace_notes: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices('workspace_notes', 'workspaceNotes'),
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
    #: Continue the conversation with the sub-agent reports waiting on it (after ``subagent_results_ready``):
    #: ``message`` / ``structured_content`` are ignored and the turn's input is built from the reports.
    continue_with_subagent_results: bool = Field(
        default=False,
        validation_alias=AliasChoices('continue_with_subagent_results', 'continueWithSubagentResults'),
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

        if self.continue_with_subagent_results:
            # The input comes from the waiting sub-agent reports, not from the request.
            return self
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


class SessionAdminElevationRequest(BaseModel):
    """Body for POST /session/admin-elevation: grant (starts UAC helper) or revoke."""

    session_id: str
    granted: bool = False


class AgentContinueRequest(BaseModel):
    """Resume an agent stream that is waiting on an approval/confirmation card."""

    session_id: str
    note: str = ''
    #: When set with a pending delete request, perform or cancel the delete before resuming.
    delete_action: Literal['confirm', 'cancel'] | None = None
    delete_request_id: str = ''
    #: When set with a pending generic command request, perform or cancel it before resuming.
    accept_command_action: Literal['confirm', 'confirm_session', 'cancel', 'deny'] | None = None
    accept_command_request_id: str = ''
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
    #: Reopening an unchanged conversation: keep a checkpoint whose sync row matches ``messages``.
    keep_matching_checkpoint: bool = False


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
    """Live reasoning caps, not a persisted setting: a llama-server Jinja scan (Electron ``GET /props``)
    or, for OpenRouter, the model catalog's ``reasoning`` block (``enableThinking`` = can be turned off).
    """

    enableThinking: bool = False
    reasoningEffortValues: list[str] | None = None
    # Claude only: the Models API says the model accepts ``thinking: {type: "adaptive"}``.
    adaptiveThinking: bool = False


class RuntimeConnectionRequest(BaseModel):
    """One connection entry inside RuntimeConfigRequest."""

    id: str
    name: str
    provider: Literal['openai', 'lmstudio', 'llamacpp', 'openrouter', 'anthropic']
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

    webSearchProvider: str = Field(
        default='auto',
        validation_alias=AliasChoices('webSearchProvider', 'web_search_provider'),
    )

    webSearchEngines: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices('webSearchEngines', 'web_search_engines'),
    )

    webSearchUserAgent: str = Field(
        default='',
        validation_alias=AliasChoices('webSearchUserAgent', 'web_search_user_agent'),
    )

    webSearchCooldownSeconds: int = Field(
        default=300,
        validation_alias=AliasChoices('webSearchCooldownSeconds', 'web_search_cooldown_seconds'),
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

    @field_validator('webSearchProvider', mode='before')
    @classmethod
    def _normalize_web_search_provider(cls, v: Any) -> Any:
        if v is None:
            return 'auto'
        text = str(v).strip().lower()
        return text if text in ('auto', 'internal', 'searxng') else 'auto'

    @field_validator('webSearchEngines', mode='before')
    @classmethod
    def _normalize_web_search_engines(cls, v: Any) -> Any:
        # Imported here so the schema module stays free of a tools import at load time.
        from clara_coder_backend.tools.metasearch.engines import ENGINE_NAMES

        if v is None:
            return []
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, (list, tuple)):
            return []
        wanted = {str(item).strip().lower() for item in v if isinstance(item, str)}
        return [name for name in ENGINE_NAMES if name in wanted]

    @field_validator('webSearchUserAgent', mode='before')
    @classmethod
    def _normalize_web_search_user_agent(cls, v: Any) -> Any:
        if v is None:
            return ''
        text = str(v).strip()
        if len(text) > 512 or any(ord(ch) < 32 or ord(ch) == 127 for ch in text):
            return ''
        return text

    @field_validator('webSearchCooldownSeconds', mode='before')
    @classmethod
    def _normalize_web_search_cooldown(cls, v: Any) -> Any:
        try:
            value = int(v)
        except (TypeError, ValueError):
            return 300
        return min(max(value, 0), 3600)
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


class McpSecretEntryRequest(BaseModel):
    key: str = ''
    value: str = ''


class McpOAuthTokensRequest(BaseModel):
    accessToken: str = ''
    refreshToken: str = ''
    expiresAt: float = 0
    clientId: str = ''
    clientSecret: str = ''
    scopes: list[str] = Field(default_factory=list)
    serverUrl: str = ''


class McpServerRequest(BaseModel):
    """One Settings → MCP entry, secrets already unwrapped by Electron."""

    model_config = ConfigDict(extra='ignore')

    id: str
    name: str = ''
    enabled: bool = False
    trust: Literal['ask', 'allow-all'] = 'ask'
    transport: Literal['stdio', 'http'] = 'stdio'
    command: str = ''
    args: list[str] = Field(default_factory=list)
    env: list[McpSecretEntryRequest] = Field(default_factory=list)
    url: str = ''
    httpTransport: Literal['streamable', 'sse'] = 'streamable'
    httpAuth: Literal['none', 'headers', 'oauth'] = 'none'
    headers: list[McpSecretEntryRequest] = Field(default_factory=list)
    oauth: McpOAuthTokensRequest | None = None
    toolDecisions: dict[str, Literal['allow', 'deny']] = Field(default_factory=dict)


class McpOAuthStartRequest(BaseModel):
    server: McpServerRequest


class McpOAuthTokensUpdateRequest(BaseModel):
    """Tokens Electron just refreshed for one configured server."""

    serverId: str
    oauth: McpOAuthTokensRequest


class RuntimeConfigRequest(BaseModel):
    """Full settings payload from the UI; replaces in-memory runtime_config."""

    activeConnectionId: str
    connections: list[RuntimeConnectionRequest]
    audio: RuntimeAudioRequest
    host: RuntimeHostRequest | None = None
    tools: RuntimeToolsRequest | None = None
    contextCompression: RuntimeContextCompressionRequest | None = None
    huggingFaceToken: str = ''
    mcpServers: list[McpServerRequest] = Field(default_factory=list)
    activeWorkspacePath: str = ''


class LogLevelRequest(BaseModel):
    """Body for POST /logs/level — matches UI ``HealthMonitorConfig.logLevel``."""

    level: Literal['debug', 'info', 'warning', 'error']


class LogIngestRequest(BaseModel):
    """Body for POST /logs/ingest (Electron main → unified log)."""

    level: str = 'INFO'
    logger: str = 'nemo.electron.main'
    message: str
    source: str = 'electron'


class WorkspacePtyRegisterRequest(BaseModel):
    """Body for POST /workspace-pty/register: Electron spawned a user PTY terminal."""

    session_id: str = Field(validation_alias=AliasChoices('session_id', 'sessionId'))
    workspace_root: str = Field(
        default='',
        validation_alias=AliasChoices('workspace_root', 'workspaceRoot'),
    )
    cwd: str = ''
    shell: str = ''
    pid: int | None = None
    cols: int = 80
    rows: int = 24


class WorkspacePtyOutputRequest(BaseModel):
    """Body for POST /workspace-pty/output: mirror PTY output chunk (and optional cwd)."""

    session_id: str = Field(validation_alias=AliasChoices('session_id', 'sessionId'))
    data: str = ''
    cwd: str = ''


class WorkspacePtyCwdRequest(BaseModel):
    """Body for POST /workspace-pty/cwd: update user PTY working directory."""

    session_id: str = Field(validation_alias=AliasChoices('session_id', 'sessionId'))
    cwd: str = ''


class WorkspacePtyExitRequest(BaseModel):
    """Body for POST /workspace-pty/exit: user PTY process exited or was killed."""

    session_id: str = Field(validation_alias=AliasChoices('session_id', 'sessionId'))
    exit_code: int | None = Field(
        default=None,
        validation_alias=AliasChoices('exit_code', 'exitCode'),
    )
    removed: bool = False
