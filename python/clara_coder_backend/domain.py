"""Plain dataclasses for in-memory runtime and per-session state.

These are not Pydantic models: they are mutated freely by route handlers and the
agent. API request/response shapes live in :mod:`clara_coder_backend.schemas`.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


@dataclass
class EditStagingEntry:
    """Pending nested edit: merged content on disk under ``CLARA_STAGING_DIR`` before code review / finalize."""

    temp_path: str
    old_text: str
    merged_text: str
    disk_encoding: str
    #: ``lf`` or ``crlf`` for disk writes.
    disk_newline: str
    #: ``full-file`` | ``line-range`` | ``snippet``
    edit_mode: str
    #: True once the approved staged draft has been materialized into the real workspace for the current chain.
    workspace_applied: bool = False


@dataclass
class WorkspaceTestMaterializationEntry:
    """Original workspace snapshot for a staged file materialized into the real workspace for test runs."""

    existed: bool
    original_text: str
    disk_encoding: str
    #: ``lf`` or ``crlf`` for disk writes.
    disk_newline: str


@dataclass
class PendingStagedTransferHitl:
    """While user reviews staged→workspace transfer(s) in the chat diff UI (auto_apply off)."""

    request_id: str
    relative_paths: list[str]
    #: path -> ``confirm`` | ``re_review`` once the user decides per file.
    resolved: dict[str, str] = field(default_factory=dict)
    feedback: dict[str, str] = field(default_factory=dict)


@dataclass
class SessionState:
    """Per-chat-session data kept while the Electron app talks to this process."""

    # Serialized chat turns: each item has "role" and "content" (user/assistant/system).
    # ``content`` is usually a string; user turns may use OpenAI-style multimodal lists.
    history: list[dict[str, Any]] = field(default_factory=list)
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
    # Selected interpreter id from discovery (``app-backend``, ``dot-venv``, …); drives Jedi env + LSP metadata.
    python_interpreter_choice_id: str = ''
    # Set by workspace edit tools; consumed by SSE diff event after tool success.
    pending_diff_payload: dict | None = None
    # Staged transfer awaiting human confirm (``transfer_staged_file_to_workspace`` / approve when auto_apply off).
    pending_staged_transfer_hitl: PendingStagedTransferHitl | None = None
    # Batch diff payloads for staged transfer HITL; consumed by SSE ``staged_transfer_batch``.
    pending_staged_transfer_batch_payload: dict | None = None
    # Nested create/update: keyed by workspace-relative POSIX path; cleared on approve/reject or planning error.
    pending_edit_stagings: dict[str, EditStagingEntry] = field(default_factory=dict)
    # Active staging snapshot namespace for temp drafts and the seeded workspace mirror.
    active_staging_snapshot_id: str = ''
    # Absolute path to the seeded workspace mirror root, or empty when no snapshot is active.
    active_staging_snapshot_root: str = ''
    # Original workspace snapshots for staged files materialized into the real workspace before reviewer test runs.
    test_run_materializations: dict[str, WorkspaceTestMaterializationEntry] = field(default_factory=dict)
    # Set by delete_workspace_entry when auto_apply is false; cleared after confirm/cancel via agent-continue.
    pending_delete_request: dict | None = None
    # Set by copy_workspace_files when auto_apply is false; cleared after confirm/cancel via agent-continue.
    pending_copy_request: dict | None = None
    # Generic HITL command approval request (for example, deferred Python dependency actions).
    pending_accept_command_request: dict | None = None
    # Plan-and-execute: proposed step list awaiting user approval before execution.
    pending_plan_confirm_request: dict | None = None
    #: Set by plan-confirm HITL when the user cancels; read by the plan orchestrator after pause.
    plan_execute_aborted: bool = False
    # Plan-and-execute: batch of clarifying questions awaiting user answers before plan confirm.
    pending_question_request: dict | None = None
    #: Structured answers returned by the question HITL; read by the orchestrator after pause.
    question_answers: list | None = None
    #: Set by question HITL when the user cancels; read by the plan orchestrator after pause.
    question_aborted: bool = False
    #: Active build plan registry id (``.nemo/build-plans``) while planning or executing.
    active_build_plan_id: str = ''
    #: Workspace-relative path to the active build plan Markdown file.
    active_build_plan_path: str = ''
    # Human-in-the-loop: agent stream awaits this after emitting a diff; POST /chat/agent-continue sets it.
    agent_pause_event: asyncio.Event | None = None
    # Note from the client, appended as HumanMessage after the pause (may be empty).
    agent_pause_note: str | None = None
    # UI/system events (e.g. user closed a run_command terminal tab) drained into HumanMessages.
    pending_user_event_notes: list[str] = field(default_factory=list)
    # Live mirror of the UI toggle; POST /session/auto-apply updates this during an in-flight stream.
    auto_apply_mode: bool = False
    #: Concurrent :func:`~clara_coder_backend.agent_langgraph._stream_langgraph_tool_agent` runs per session (nested SSE workers).
    active_langgraph_agent_streams: int = 0
    #: Subset of those started with ``apply_mode=True`` (Editor on). Drives ``worker_apply_mode`` together with the count.
    active_editor_langgraph_streams: int = 0
    # LangGraph worker: editor/apply mode for this delegated task (mirrors chat apply_mode).
    worker_apply_mode: bool = False
    # LangGraph worker: middleware signals here so the SSE loop can emit a diff before on_tool_end.
    hitl_sse_queue: asyncio.Queue | None = None
    # Set when the client requests an abort; the streaming generator checks this to bail out early.
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)
    # Outer ``/chat/stream`` allocates this queue so subprocess tools (pytest, smoke, overlay, …) can emit ``tool_exec_*`` SSE.
    planning_nested_events_q: asyncio.Queue | None = None
    # While True, chat-model token deltas from the parent graph's ``astream_events`` queue are not sent as SSE
    # chunks. Nested subgraph LLM streams are still surfaced on that parent queue with the outer tag; the
    # dedicated ``planning_nested_events_q`` path already omits tokens—this prevents duplicate ``agent`` chunks.
    suppress_parent_graph_model_token_sse: bool = False
    # Active LSP phase: `staging` while reviewing staged drafts, `workspace` for the final real-workspace pass.
    lsp_active_scope: str = 'workspace'
    # Workspace root last associated with an LSP subprocess (empty when none have started).
    lsp_workspace_root: str = ''
    # Auto-detected TypeScript/Node project root used for typescript-language-server cwd (nested ``package.json``).
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
    # Last ``POST /chat/stream`` apply/auto-apply flags (conversation turn; set by :mod:`clara_coder_backend.agent`).
    last_stream_apply_mode: bool | None = None
    last_stream_auto_apply_mode: bool | None = None
    #: Last ``POST /chat/stream`` speech/TTS flag (drives mood-tag prompt guidance).
    last_stream_speech_enabled: bool = False


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
    parallel_tool_calls: bool = False
    #: ``generic`` | ``qwen`` | ``capable`` | ``gemma`` — from Settings optimization template.
    optimization_preset: str = 'generic'
    #: Chat max_tokens when > 0; 0 means use preset/env defaults.
    max_output_tokens: int = 0
    #: Max number of final project-review retry attempts for this connection.
    plan_retry_attempts_count: int = 2
    #: Gemma / LM Studio thinking: ``default`` | ``on`` | ``off`` (not OpenAI ``reasoning_effort`` tiers).
    thinking_mode: str = 'default'
    #: ``provider-default`` | ``gemma-recommended`` | ``custom``
    sampling_preset: str = 'provider-default'
    #: When ``sampling_preset`` is ``custom``, optional ``top_p`` (else ``None``).
    top_p: float | None = None
    #: When ``sampling_preset`` is ``custom``, optional ``top_k`` (else ``None``).
    top_k: int | None = None
    #: ``auto`` | ``dense`` — sparse-expert Gemma notes are inferred from the model id when ``auto``.
    architecture_hint: str = 'auto'
    #: OpenAI-compatible embeddings API base (managed embedding ``llama-server``); empty = use env / chat URL.
    embeddings_base_url: str = ''
    #: False when the llama.cpp preset has no embedding server (empty ``llamaCppManaged.embeddingRunCommand``); skips semantic index.
    embeddings_enabled: bool = True
    #: OpenAI-compatible embeddings model id (Settings → LM Studio); empty uses env default.
    embeddings_model: str = ''
    #: Optional ``min_p`` (0–1); locals often read it from chat completion ``extra_body``.
    min_p: float | None = None
    #: Optional OpenAI ``presence_penalty`` (-2–2) when set.
    presence_penalty: float | None = None
    #: Optional llama.cpp ``repeat_penalty`` in ``extra_body`` when set (not ``repetition_penalty`` on the wire).
    repeat_penalty: float | None = None
    #: Main context window for this connection (from Settings); used for checkpoint compaction budgets.
    context_window_tokens: int = 0


@dataclass
class RuntimeContextCompressionConfig:
    """LangGraph checkpoint compaction settings (Settings → Tools)."""

    enabled: bool = True
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


@dataclass
class RuntimeConfig:
    """Full runtime settings chosen in the desktop UI and POSTed to /runtime-config."""

    active_connection_id: str
    connections: list[RuntimeConnection]
    audio: RuntimeAudioConfig
    host: RuntimeHostConfig = field(default_factory=RuntimeHostConfig)
    tools: RuntimeToolsConfig = field(default_factory=RuntimeToolsConfig)
    context_compression: RuntimeContextCompressionConfig = field(default_factory=RuntimeContextCompressionConfig)
