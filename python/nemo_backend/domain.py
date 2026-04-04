"""Plain dataclasses for in-memory runtime and per-session state.

These are not Pydantic models: they are mutated freely by route handlers and the
agent. API request/response shapes live in :mod:`nemo_backend.schemas`.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class SessionState:
    """Per-chat-session data kept while the Electron app talks to this process."""

    # Serialized chat turns: each item has "role" and "content" (user/assistant/system).
    history: list[dict[str, str]] = field(default_factory=list)
    # Absolute path to the folder the user opened as workspace, or empty.
    workspace_path: str = ''
    # Tree snapshot string pushed from the renderer (for system prompt + snapshot tool).
    workspace_context: str = ''
    # Recent file activity summary from the app, also fed into prompts.
    workspace_state: str = ''
    # Set by workspace edit tools; consumed by SSE diff event after tool success.
    pending_diff_payload: dict | None = None
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
    # LangGraph manager only: nested worker graph events merged into the manager SSE loop during delegate_workspace_task.
    delegate_nested_events_q: asyncio.Queue | None = None
    # Set while delegate runs; SSE loop signals after it consumes the nested stream end sentinel.
    delegate_nested_done_event: asyncio.Event | None = None


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


@dataclass
class RuntimeConfig:
    """Full runtime settings chosen in the desktop UI and POSTed to /runtime-config."""

    active_connection_id: str
    connections: list[RuntimeConnection]
    audio: RuntimeAudioConfig
    host: RuntimeHostConfig = field(default_factory=RuntimeHostConfig)
    tools: RuntimeToolsConfig = field(default_factory=RuntimeToolsConfig)
