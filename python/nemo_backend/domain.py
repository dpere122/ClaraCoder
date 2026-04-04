"""Plain dataclasses for in-memory runtime and per-session state.

These are not Pydantic models: they are mutated freely by route handlers and the
agent. API request/response shapes live in :mod:`nemo_backend.schemas`.
"""

from __future__ import annotations

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
class RuntimeConfig:
    """Full runtime settings chosen in the desktop UI and POSTed to /runtime-config."""

    active_connection_id: str
    connections: list[RuntimeConnection]
    audio: RuntimeAudioConfig
    host: RuntimeHostConfig = field(default_factory=RuntimeHostConfig)
