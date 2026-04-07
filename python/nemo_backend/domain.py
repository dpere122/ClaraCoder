"""Plain dataclasses for in-memory runtime and per-session state.

These are not Pydantic models: they are mutated freely by route handlers and the
agent. API request/response shapes live in :mod:`nemo_backend.schemas`.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class EditStagingEntry:
    """Pending nested edit: merged content on disk under ``NEMO_STAGING_DIR`` before code review / finalize."""

    temp_path: str
    old_text: str
    merged_text: str
    disk_encoding: str
    #: ``lf`` or ``crlf`` for disk writes.
    disk_newline: str
    #: ``full-file`` | ``line-range`` | ``snippet``
    edit_mode: str


@dataclass
class SessionState:
    """Per-chat-session data kept while the Electron app talks to this process."""

    # Serialized chat turns: each item has "role" and "content" (user/assistant/system).
    history: list[dict[str, str]] = field(default_factory=list)
    # Absolute path to the folder the user opened as workspace, or empty.
    workspace_path: str = ''
    # Tree snapshot string pushed from the renderer (for system prompt workspace hint).
    workspace_context: str = ''
    # Set by workspace edit tools; consumed by SSE diff event after tool success.
    pending_diff_payload: dict | None = None
    # Nested create/update: keyed by workspace-relative POSIX path; cleared on approve/reject or planning error.
    pending_edit_stagings: dict[str, EditStagingEntry] = field(default_factory=dict)
    # Set by delete_workspace_entry when auto_apply is false; cleared after confirm/cancel via agent-continue.
    pending_delete_request: dict | None = None
    # Human-in-the-loop: agent stream awaits this after emitting a diff; POST /chat/agent-continue sets it.
    agent_pause_event: asyncio.Event | None = None
    # Note from the client, appended as HumanMessage after the pause (may be empty).
    agent_pause_note: str | None = None
    # Live mirror of the UI toggle; POST /session/auto-apply updates this during an in-flight stream.
    auto_apply_mode: bool = False
    # LangGraph worker: editor/apply mode for this delegated task (mirrors chat apply_mode).
    worker_apply_mode: bool = False
    # LangGraph worker: middleware signals here so the SSE loop can emit a diff before on_tool_end.
    hitl_sse_queue: asyncio.Queue | None = None
    # Set when the client requests an abort; the streaming generator checks this to bail out early.
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)
    # LangGraph manager only: nested planning graph events merged into the manager SSE loop during modify_workspace.
    planning_nested_events_q: asyncio.Queue | None = None
    # Set while nested planning runs; SSE loop signals after it consumes the nested stream end sentinel.
    planning_nested_done_event: asyncio.Event | None = None
    # While True, chat-model token deltas from the parent graph's ``astream_events`` queue are not sent as SSE
    # chunks. Nested subgraph LLM streams are still surfaced on that parent queue with the outer tag; the
    # dedicated ``planning_nested_events_q`` path already omits tokens—this prevents duplicate ``agent`` chunks.
    suppress_parent_graph_model_token_sse: bool = False


@dataclass
class RuntimeConnection:
    """One LLM endpoint: OpenAI cloud or a local OpenAI-compatible server (e.g. LM Studio)."""

    id: str
    name: str
    provider: str
    base_url: str
    model: str
    api_key: str = ''
    # For OpenAI-style reasoning models via Chat Completions: minimal|low|medium|high; empty = omit.
    reasoning_effort: str = ''
    temperature: float = 0.0
    parallel_tool_calls: bool = False
    #: ``generic`` | ``qwen`` — from Settings optimization template.
    optimization_preset: str = 'generic'
    #: Chat max_tokens when > 0; 0 means use preset/env defaults.
    max_output_tokens: int = 0


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


@dataclass
class RuntimeConfig:
    """Full runtime settings chosen in the desktop UI and POSTed to /runtime-config."""

    active_connection_id: str
    connections: list[RuntimeConnection]
    audio: RuntimeAudioConfig
    host: RuntimeHostConfig = field(default_factory=RuntimeHostConfig)
    tools: RuntimeToolsConfig = field(default_factory=RuntimeToolsConfig)
