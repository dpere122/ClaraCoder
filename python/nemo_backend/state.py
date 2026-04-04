"""Process-wide session store and runtime configuration.

The Electron app can run multiple chat sessions (by id). Each maps to a
:class:`~nemo_backend.domain.SessionState`. LLM/audio settings live in a single
mutable :class:`~nemo_backend.domain.RuntimeConfig` updated via POST /runtime-config.

``current_session_id`` is a :class:`contextvars.ContextVar` so concurrent
async requests do not cross wires when workspace tools resolve the active session.
"""

from __future__ import annotations

import contextvars

from fastapi import HTTPException

from nemo_backend.config import (
    DEFAULT_LM_STUDIO_BASE_URL,
    DEFAULT_LM_STUDIO_MODEL,
    DEFAULT_OPENAI_BASE_URL,
    DEFAULT_OPENAI_MODEL,
    DEFAULT_TRANSCRIBE_MODEL,
)
from nemo_backend.domain import (
    RuntimeAudioConfig,
    RuntimeConfig,
    RuntimeConnection,
    RuntimeHostConfig,
    SessionState,
)

# Which session_id workspace tools and the agent should use for the current task.
current_session_id: contextvars.ContextVar[str] = contextvars.ContextVar('current_session_id', default='')

# All known sessions; created on demand via get_session().
sessions: dict[str, SessionState] = {}


def build_default_runtime_config() -> RuntimeConfig:
    """Factory used on startup: OpenAI + LM Studio presets with empty API keys."""
    openai_connection = RuntimeConnection(
        id='default-openai',
        name='OpenAI Default',
        provider='openai',
        base_url=DEFAULT_OPENAI_BASE_URL,
        model=DEFAULT_OPENAI_MODEL,
        api_key='',
    )
    lmstudio_connection = RuntimeConnection(
        id='default-lmstudio',
        name='LM Studio Local',
        provider='lmstudio',
        base_url=DEFAULT_LM_STUDIO_BASE_URL,
        model=DEFAULT_LM_STUDIO_MODEL,
        api_key='lm-studio',
    )
    return RuntimeConfig(
        active_connection_id=openai_connection.id,
        connections=[openai_connection, lmstudio_connection],
        audio=RuntimeAudioConfig(
            provider='openai',
            base_url=DEFAULT_OPENAI_BASE_URL,
            model=DEFAULT_TRANSCRIBE_MODEL,
            api_key='',
        ),
        host=RuntimeHostConfig(),
    )


# Live settings; replaced entirely when the client POSTs /runtime-config.
runtime_config: RuntimeConfig = build_default_runtime_config()


def get_session(session_id: str) -> SessionState:
    """Return existing session state or create an empty one for this id."""
    return sessions.setdefault(session_id, SessionState())


def get_active_connection() -> RuntimeConnection:
    """Resolve the LLM connection matching active_connection_id, or fall back to the first."""
    if not runtime_config.connections:
        raise HTTPException(status_code=500, detail='No LLM connections are configured.')

    for connection in runtime_config.connections:
        if connection.id == runtime_config.active_connection_id:
            return connection

    return runtime_config.connections[0]


def require_openai_api_key(api_key: str, provider_label: str) -> None:
    """Raise HTTP 500 if a feature needs an OpenAI key but none is configured."""
    if not api_key:
        raise HTTPException(status_code=500, detail=f'{provider_label} API key is not configured.')
