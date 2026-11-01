"""Shared dataclasses for runtime settings and per-session state.

Leaf module: no imports from ``session`` or feature packages. These are not
Pydantic models — they are mutated freely by route handlers and the agent.
API request/response shapes live in :mod:`clara_coder_backend.session.schemas`.
The process-wide store lives in :mod:`clara_coder_backend.session.state`.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SessionWorkspaceState:
    """Workspace attachment, semantic index batching, and Python env resolution."""

    # Absolute path to the folder the user opened as workspace, or empty.
    workspace_path: str = ''
    # App workspace card id (Electron ``Workspace.id``); used for internal semantic index paths.
    workspace_id: str = ''
    # Tree snapshot string pushed from the renderer (for system prompt workspace hint).
    workspace_context: str = ''
    # Optional per-workspace system prompt text (Electron app-data managed copy).
    workspace_system_prompt: str = ''
    # Batched file watcher paths for incremental semantic index updates ``(path, kind)``.
    semantic_index_pending: list[tuple[str, str]] = field(default_factory=list)
    # Resolved Python project root inside the active workspace, or empty when none is attached.
    python_workspace_root: str = ''
    # Human-readable label for the resolved Python project root: `.` or `python/`.
    python_workspace_root_label: str = ''
    # Absolute path to the active workspace virtual environment, or empty when none is attached.
    python_workspace_venv_path: str = ''
    # Absolute path to the workspace Python executable, or empty when none is attached.
    python_workspace_python_executable: str = ''
    # Absolute path to the workspace venv bin/Scripts directory used to prefix PATH.
    python_workspace_bin_path: str = ''
    # Most recent workspace Python environment status summary.
    python_workspace_env_summary: str = ''
    # Selected interpreter id from discovery (``app-backend``, ``dot-venv``, …); drives Python LSP analysis env.
    python_interpreter_choice_id: str = ''


@dataclass
class SessionHitlState:
    """Human-in-the-loop pause fields, pending approvals, and SSE bridging."""

    # Set by delete_workspace_entries for a directory too large to journal; cleared after confirm/cancel.
    pending_delete_request: dict | None = None
    # Generic HITL command approval request (for example, deferred Python dependency actions).
    pending_accept_command_request: dict | None = None
    #: True after the composer Admin chip HITL; not cleared on ``/load``.
    admin_elevation_granted: bool = False
    # Plan-and-execute: proposed step list awaiting user approval before execution.
    pending_plan_confirm_request: dict | None = None
    #: Set by plan-confirm HITL when the user cancels; read by the plan orchestrator after pause.
    plan_execute_aborted: bool = False
    # Plan-and-execute: batch of clarifying questions awaiting user answers before plan confirm.
    pending_question_request: dict | None = None
    #: Structured answers returned by the question HITL; read by the plan orchestrator after pause.
    question_answers: list | None = None
    #: Set by question HITL when the user cancels; read by the plan orchestrator after pause.
    question_aborted: bool = False
    # Human-in-the-loop: agent stream awaits this after emitting a diff; POST /chat/agent-continue sets it.
    agent_pause_event: asyncio.Event | None = None
    #: Serializes HITL pauses so parallel ToolNode tasks cannot clobber ``agent_pause_event``.
    hitl_pause_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Note from the client, appended as HumanMessage after the pause (may be empty).
    agent_pause_note: str | None = None
    #: How long the work an approval answer ran took (the command, fetch, MCP call or delete), in ms.
    #: None when the answer ran nothing (cancel, deny). The paused call reports it as its duration.
    agent_pause_run_ms: int | None = None
    # UI/system events (e.g. user closed a run_command terminal tab) drained into HumanMessages.
    pending_user_event_notes: list[str] = field(default_factory=list)
    # LangGraph worker: middleware signals here so the SSE loop can emit a diff before on_tool_end.
    hitl_sse_queue: asyncio.Queue | None = None
    #: Event loop that owns ``hitl_sse_queue``; tool worker threads post through it with ``call_soon_threadsafe``.
    hitl_sse_loop: asyncio.AbstractEventLoop | None = None


@dataclass
class SessionEditJournalState:
    """Per-turn record of which paths already have a pre-edit journal row (edits write straight to disk)."""

    #: ``current_user_message_id`` the ``journaled_paths`` set belongs to; a new turn resets the set.
    journal_turn_id: str = ''
    #: Workspace-relative POSIX paths whose pre-turn bytes were already journaled this turn.
    journaled_paths: set[str] = field(default_factory=set)
    #: ``journaled_paths`` of recent earlier turns (bounded): a background sub-agent still journals under
    #: the turn that started it while the main agent works on a newer one; neither re-journals a path.
    journal_earlier_turns: dict[str, set[str]] = field(default_factory=dict)


@dataclass
class SessionLspState:
    """LSP subprocess scope, project roots, and diagnostics caches."""

    # Active LSP phase: `staging` while reviewing staged drafts, `workspace` for the final real-workspace pass.
    lsp_active_scope: str = 'workspace'
    # Workspace root last associated with an LSP subprocess (empty when none have started).
    lsp_workspace_root: str = ''
    # Auto-detected TypeScript/Node project root used as vtsls cwd (nested ``package.json``).
    typescript_lsp_resolved_root: str = ''
    # Auto-detected Java project root used for Eclipse JDT LS cwd (Maven/Gradle markers).
    java_lsp_resolved_root: str = ''
    # One-shot npm project rows from workspace attach (``discover_workspace_npm_projects``); not refreshed on status polls.
    npm_project_hints: list[dict[str, Any]] | None = None
    # Monotonic timestamp (``time.time()``) when ``npm_project_hints`` was last populated.
    npm_discovery_at: float | None = None
    # Ephemeral LSP workspace mirror for staging scope (``.../uuid/workspace``); empty when none.
    lsp_staging_overlay_root: str = ''
    # Parent of the overlay workspace folder for ``shutil.rmtree`` teardown.
    lsp_staging_overlay_parent: str = ''
    # Cached normalized diagnostics keyed by LSP scope (`workspace` / `staging`) then path.
    lsp_diagnostics_by_scope: dict[str, dict[str, list[dict[str, object]]]] = field(
        default_factory=lambda: {'workspace': {}, 'staging': {}}
    )
    # Monotonic LSP manager generation (survives subprocess recreate; editor watch uses this).
    lsp_sync_epoch: int = 0


@dataclass
class SessionStreamState:
    """Streaming flags, nested LangGraph workers, and abort signaling."""

    # Live mirror of the Auto Run toggle (skips command/web/MCP approval cards); POST /session/auto-apply updates it.
    auto_apply_mode: bool = False
    #: Concurrent :func:`~clara_coder_backend.lang_agent.graph._stream_langgraph_tool_agent` runs per session (nested SSE workers).
    active_langgraph_agent_streams: int = 0
    #: Subset of those started with ``apply_mode=True`` (Editor on). Drives ``worker_apply_mode`` together with the count.
    active_editor_langgraph_streams: int = 0
    # LangGraph worker: editor/apply mode for this delegated task (mirrors chat apply_mode).
    worker_apply_mode: bool = False
    # Set when the client requests an abort; the streaming generator checks this to bail out early.
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)
    # Outer ``/chat/stream`` allocates this queue so subprocess tools (pytest, smoke, overlay, …) can emit ``tool_exec_*`` SSE.
    planning_nested_events_q: asyncio.Queue | None = None
    # Event loop that owns ``planning_nested_events_q``; worker threads (write jobs) post via ``call_soon_threadsafe``.
    planning_nested_events_loop: asyncio.AbstractEventLoop | None = None
    # While True, chat-model token deltas from the parent graph's ``astream_events`` queue are not sent as SSE
    # chunks. Nested subgraph LLM streams are still surfaced on that parent queue with the outer tag; the
    # dedicated ``planning_nested_events_q`` path already omits tokens—this prevents duplicate ``agent`` chunks.
    suppress_parent_graph_model_token_sse: bool = False
    # Last ``POST /chat/stream`` apply/auto-apply flags (conversation turn; set by :mod:`clara_coder_backend.composer`).
    last_stream_apply_mode: bool | None = None
    last_stream_auto_apply_mode: bool | None = None
    #: Last ``POST /chat/stream`` speech/TTS flag (spoken replies; mood tag only with openai-compatible TTS).
    last_stream_speech_enabled: bool = False
    #: Last ``POST /chat/stream`` TTS backend (``kokoro`` | ``openai-compatible``).
    last_stream_tts_provider: str = 'kokoro'
    #: Context pack ids activated this session (inject-once playbooks).
    activated_context_packs: set[str] = field(default_factory=set)
    #: Electron user-message id for the in-flight turn (conversation timeline journal).
    current_user_message_id: str = ''


@dataclass
class SessionPlanState:
    """Active build plan registry pointer while planning or executing."""

    #: Active build plan registry id (``.clara/build-plans``) while planning or executing.
    active_build_plan_id: str = ''
    #: Workspace-relative path to the active build plan Markdown file.
    active_build_plan_path: str = ''


@dataclass
class SessionAgentState:
    """Sub-agent links: a child's parent, a parent's running children, and their per-call bookkeeping.

    Sub-agents belong to the parent conversation, not to the turn that started them: they outlive it,
    and their reports wait here until the main agent gets them. Fields carry a ``subagent_`` prefix
    because every nested field is also a flat ``SessionState`` name.
    """

    #: Parent session id when this session is a sub-agent (one-shot clone of the main agent); empty otherwise.
    subagent_parent_session_id: str = ''
    #: Short label the main agent gave this sub-agent (``spawn_subagent`` ``name``).
    subagent_name: str = ''
    #: Running sub-agent turns by child session id (parent sessions only).
    subagent_children: dict[str, asyncio.Task] = field(default_factory=dict)
    #: Caps this parent's concurrent sub-agents; created on the first spawn (binds to the running loop).
    subagent_semaphore: asyncio.Semaphore | None = None
    #: Workspace-relative paths this sub-agent mutated (every mutation, not only the journaled first one).
    subagent_touched_paths: set[str] = field(default_factory=set)
    #: Results for spawn calls an ended turn left open, by the call's ``tool_call_id`` (parent only).
    subagent_interrupted_reports: dict[str, str] = field(default_factory=dict)
    #: Finished sub-agents' reports the main agent has not received yet, by child id in finish order
    #: (parent only). Kept across ``/load``; dropped with the conversation (``/clear``, ``/dispose``).
    subagent_pending_reports: dict[str, Any] = field(default_factory=dict)
    #: Reports the live turn took (its input, spawn / wait results, injected messages); put back if the
    #: turn's thread is dropped (it failed, or a plan turn stopped), so none is lost (parent only).
    subagent_turn_reports: list[Any] = field(default_factory=list)
    #: Chat turns of this main session in progress (reports queued meanwhile go to them, not the bus).
    subagent_live_turns: int = 0
    #: Stop requested before or while this sub-agent's turn starts (its composer clears ``abort_event``).
    subagent_cancel_requested: bool = False


def _nest_prop(nest: str, attr: str):
    def g(self):  # noqa: ANN001
        return getattr(getattr(self, nest), attr)

    def s(self, v):  # noqa: ANN001
        setattr(getattr(self, nest), attr, v)

    return property(g, s)


_NEST_CLASSES: dict[str, type] = {
    'workspace': SessionWorkspaceState,
    'hitl': SessionHitlState,
    'edits': SessionEditJournalState,
    'lsp': SessionLspState,
    'stream': SessionStreamState,
    'plans': SessionPlanState,
    'agents': SessionAgentState,
}

_FLAT_FIELD_TO_NEST: dict[str, tuple[str, str]] = {}
for _nest_name, _nest_cls in _NEST_CLASSES.items():
    for _field in _nest_cls.__dataclass_fields__:
        _FLAT_FIELD_TO_NEST[_field] = (_nest_name, _field)


class SessionState:
    """Per-chat-session data kept while the Electron app talks to this process."""

    history: list[dict[str, Any]]
    last_touched: float
    workspace: SessionWorkspaceState
    hitl: SessionHitlState
    edits: SessionEditJournalState
    lsp: SessionLspState
    stream: SessionStreamState
    plans: SessionPlanState
    agents: SessionAgentState

    def __init__(self, **kwargs: Any) -> None:
        self.history = kwargs.pop('history', [])
        self.last_touched = kwargs.pop('last_touched', 0.0)
        for nest_name, nest_cls in _NEST_CLASSES.items():
            provided = kwargs.pop(nest_name, None)
            setattr(self, nest_name, provided if provided is not None else nest_cls())
        for key, value in list(kwargs.items()):
            if key not in _FLAT_FIELD_TO_NEST:
                raise TypeError(f'SessionState() got an unexpected keyword argument {key!r}')
            nest_name, attr = _FLAT_FIELD_TO_NEST[key]
            setattr(getattr(self, nest_name), attr, value)
            del kwargs[key]


for _flat, (_nest_name, _attr) in _FLAT_FIELD_TO_NEST.items():
    setattr(SessionState, _flat, _nest_prop(_nest_name, _attr))


@dataclass
class RuntimeConnection:
    """One LLM endpoint: OpenAI cloud or a local OpenAI-compatible server (e.g. LM Studio)."""

    id: str
    name: str
    provider: str
    base_url: str
    model: str
    api_key: str = ''
    # Stored UI/config value; llm.py maps on→medium, off→none, and passes none|minimal|…|xhigh through.
    reasoning_effort: str = ''
    temperature: float = 0.0
    parallel_tool_calls: bool = True
    #: ``generic`` | ``qwen`` | ``gemma`` — from Settings optimization template.
    optimization_preset: str = 'generic'
    #: Chat max_tokens when > 0; 0 omits the cap (server context still limits).
    max_output_tokens: int = 0
    #: Gemma / LM Studio thinking: ``default`` | ``on`` | ``off`` (not OpenAI ``reasoning_effort`` tiers).
    thinking_mode: str = 'default'
    #: Legacy sampling-preset label (UI removed); inference uses ``top_p`` / ``top_k`` directly.
    sampling_preset: str = 'provider-default'
    #: Optional Chat Completions ``top_p`` (else ``None`` / omit).
    top_p: float | None = None
    #: Optional ``top_k`` via ``extra_body`` for local OpenAI-compatible servers (else ``None`` / omit).
    top_k: int | None = None
    #: Unused legacy field kept for config compatibility (no longer drives prompts).
    architecture_hint: str = 'auto'
    #: OpenAI-compatible embeddings API base (managed embedding ``llama-server``); empty = use env / chat URL.
    embeddings_base_url: str = ''
    #: True when HTTP embeddings are usable (OpenAI; LM Studio model; live llama.cpp embed URL).
    embeddings_enabled: bool = True
    #: OpenAI-compatible embeddings model id (Settings → LM Studio); empty uses env default.
    embeddings_model: str = ''
    #: True when the user configured HTTP embeddings (including a managed embed command not yet healthy).
    embeddings_configured: bool = False
    #: Optional ``min_p`` (0–1); locals often read it from chat completion ``extra_body``.
    min_p: float | None = None
    #: Optional OpenAI ``presence_penalty`` (-2–2) when set.
    presence_penalty: float | None = None
    #: Optional llama.cpp ``repeat_penalty`` in ``extra_body`` when set (not ``repetition_penalty`` on the wire).
    repeat_penalty: float | None = None
    #: Main context window for this connection (from Settings); used for checkpoint compaction budgets.
    context_window_tokens: int = 0
    #: Live llama-server Jinja scan: ``{enableThinking, reasoningEffortValues}`` or None when unknown.
    chat_template_reasoning: dict[str, Any] | None = None

    def __repr__(self) -> str:
        masked_key = '***' if self.api_key else ''
        return (
            f'RuntimeConnection(id={self.id!r}, name={self.name!r}, provider={self.provider!r}, '
            f'base_url={self.base_url!r}, model={self.model!r}, api_key={masked_key!r}, '
            f'reasoning_effort={self.reasoning_effort!r}, temperature={self.temperature!r}, '
            f'parallel_tool_calls={self.parallel_tool_calls!r}, '
            f'optimization_preset={self.optimization_preset!r}, '
            f'max_output_tokens={self.max_output_tokens!r}, …)'
        )

    def __str__(self) -> str:
        return self.__repr__()


@dataclass
class RuntimeContextCompressionConfig:
    """LangGraph checkpoint compaction settings (Settings → Tools).

    Applies mid-turn (before each model call) and post-turn when enabled.
    """

    enabled: bool = False
    trigger_ratio: float = 0.70
    target_ratio: float = 0.55
    protect_tail_messages: int = 24
    recent_tool_body_max_chars: int = 2000
    old_tool_body_max_chars: int = 400
    system_reserve_ratio: float = 0.25


@dataclass
class RuntimeAudioConfig:
    """Settings for speech-to-text (and related API client construction)."""

    provider: str
    base_url: str
    model: str
    api_key: str = ''
    custom_models_dir: str = ''

    def __repr__(self) -> str:
        masked_key = '***' if self.api_key else ''
        return (
            f'RuntimeAudioConfig(provider={self.provider!r}, base_url={self.base_url!r}, '
            f'model={self.model!r}, api_key={masked_key!r}, '
            f'custom_models_dir={self.custom_models_dir!r})'
        )

    def __str__(self) -> str:
        return self.__repr__()


@dataclass
class RuntimeHostConfig:
    """Host OS metadata from the Electron app, injected into the system prompt."""

    platform: str = ''
    release: str = ''
    arch: str = ''
    version: str = ''
    label: str = ''


@dataclass
class RuntimeToolsConfig:
    """Workspace agent tool limits and whether snippet-based edit tool is bound (Settings → Tools)."""

    edit_tools_strict: bool = False
    max_file_read_lines: int = 400
    max_search_results: int = 40
    #: Default text encoding for read/search/edit tools when the model omits ``encoding`` (Python codec name).
    default_workspace_encoding: str = 'utf-8'
    #: Default newline mode for edit writes: ``lf``, ``crlf``, or ``preserve`` (match existing file when present).
    default_workspace_newline: str = 'lf'
    #: When True, nested code review may call ``run_staging_overlay_command`` (Settings → Tools).
    allow_staging_overlay_commands: bool = False
    #: When True and Auto-apply is off, asks the model for a description + low/medium/high risk rating for
    #: each ``run_command`` approval request, shown on the confirmation card (Settings → Tools).
    command_line_explain_step: bool = False
    #: When True, list/search/tree/semantic indexing include all workspace paths (no built-in or ``.gitignore`` skips).
    expose_all_workspace_files: bool = False
    #: When True, bind ``web_search`` / ``fetch_url`` agent tools (Settings → Tools).
    allow_web_access: bool = False
    #: SearXNG instance base URL for ``web_search`` (e.g. ``http://127.0.0.1:8080``).
    searxng_base_url: str = ''
    #: ``web_search`` backend: ``auto`` (SearXNG when a base URL is set, else the built-in
    #: metasearch engine), ``internal`` (always built-in), or ``searxng`` (always SearXNG).
    web_search_provider: str = 'auto'
    #: Built-in metasearch engines to query (``duckduckgo``, ``bing``, ``mojeek``, ``wikipedia``).
    #: Empty means every engine (Settings → Tools).
    web_search_engines: list[str] = field(default_factory=list)
    #: User-Agent sent with built-in engine requests; empty uses the built-in default.
    web_search_user_agent: str = ''
    #: Seconds an engine is skipped after a blocker (rate limit, challenge page). 0 disables.
    web_search_cooldown_seconds: int = 300
    #: Extra directories prepended onto agent ``run_command`` PATH (Settings → Tools).
    extra_user_path: str = ''
    #: When True, auto-run Black/Prettier after edits and bind format_* tools (Settings → Tools).
    enable_agent_formatters: bool = False


@dataclass
class RuntimeMcpServer:
    """One MCP server from Settings, with secrets already unwrapped."""

    id: str
    name: str = ''
    enabled: bool = False
    #: ``ask`` or ``allow-all``.
    trust: str = 'ask'
    #: ``stdio`` or ``http``.
    transport: str = 'stdio'
    command: str = ''
    args: list[str] = field(default_factory=list)
    env: list[tuple[str, str]] = field(default_factory=list)
    url: str = ''
    #: ``streamable`` or ``sse``.
    http_transport: str = 'streamable'
    #: ``none``, ``headers``, or ``oauth``.
    http_auth: str = 'none'
    headers: list[tuple[str, str]] = field(default_factory=list)
    oauth_access_token: str = ''
    oauth_refresh_token: str = ''
    oauth_expires_at: float = 0
    oauth_client_id: str = ''
    oauth_client_secret: str = ''
    oauth_scopes: list[str] = field(default_factory=list)
    #: Server URL the OAuth tokens and client were issued for. They are not used for any other URL.
    oauth_server_url: str = ''
    #: Remote tool name → ``allow`` or ``deny``.
    tool_decisions: dict[str, str] = field(default_factory=dict)


@dataclass
class RuntimeConfig:
    """Full runtime settings chosen in the desktop UI and POSTed to /runtime-config."""

    active_connection_id: str
    connections: list[RuntimeConnection]
    audio: RuntimeAudioConfig
    host: RuntimeHostConfig = field(default_factory=RuntimeHostConfig)
    tools: RuntimeToolsConfig = field(default_factory=RuntimeToolsConfig)
    context_compression: RuntimeContextCompressionConfig = field(default_factory=RuntimeContextCompressionConfig)
    mcp_servers: list[RuntimeMcpServer] = field(default_factory=list)
    #: Active workspace directory. MCP stdio cwd and the advertised root follow this path.
    active_workspace_path: str = ''
