"""Process-wide session store and runtime configuration.

The Electron app can run multiple chat sessions (by id). Each maps to a
:class:`~clara_coder_backend.domain.SessionState`. LLM/audio settings live in a single
mutable :class:`~clara_coder_backend.domain.RuntimeConfig` updated via POST /runtime-config
(including :class:`~clara_coder_backend.domain.RuntimeToolsConfig` from Settings → Tools).

``current_session_id`` is a :class:`contextvars.ContextVar` so concurrent
async requests do not cross wires when workspace tools resolve the active session.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import time

from fastapi import HTTPException

from clara_coder_backend.config import (
    DEFAULT_LM_STUDIO_BASE_URL,
    DEFAULT_LM_STUDIO_MODEL,
    DEFAULT_OPENAI_BASE_URL,
    DEFAULT_OPENAI_MODEL,
    DEFAULT_WHISPER_MODEL,
    MAX_FILE_READ_LINES,
    MAX_SEARCH_RESULTS,
    CLARA_EDIT_TOOLS_STRICT,
)
from clara_coder_backend.domain import (
    RuntimeAudioConfig,
    RuntimeConfig,
    RuntimeConnection,
    RuntimeHostConfig,
    RuntimeToolsConfig,
    SessionState,
)

logger = logging.getLogger('clara.session.state')

# Which session_id workspace tools and the agent should use for the current task.
current_session_id: contextvars.ContextVar[str] = contextvars.ContextVar('current_session_id', default='')

# Id of the model message whose tool calls are running (parallel calls share it); empty outside a tool call.
current_tool_batch_id: contextvars.ContextVar[str] = contextvars.ContextVar('current_tool_batch_id', default='')

# All known sessions; created on demand via get_session().
sessions: dict[str, SessionState] = {}

#: Idle sessions older than this may be evicted when the store grows.
SESSION_IDLE_TTL_SEC = 2 * 3600
#: Opportunistic prune runs from get_session when the dict exceeds this size.
SESSION_PRUNE_THRESHOLD = 32

#: Reentrancy guard for ``prune_idle_sessions`` (eviction cleanup can call ``get_session``).
_pruning = False


def build_default_runtime_config() -> RuntimeConfig:
    """Factory used on startup: OpenAI + LM Studio presets with empty API keys."""
    openai_connection = RuntimeConnection(
        id='default-openai',
        name='OpenAI Default',
        provider='openai',
        base_url=DEFAULT_OPENAI_BASE_URL,
        model=DEFAULT_OPENAI_MODEL,
        api_key='',
        temperature=0.0,
        parallel_tool_calls=True,
        optimization_preset='generic',
        max_output_tokens=0,
    )
    lmstudio_connection = RuntimeConnection(
        id='default-lmstudio',
        name='LM Studio Local',
        provider='lmstudio',
        base_url=DEFAULT_LM_STUDIO_BASE_URL,
        model=DEFAULT_LM_STUDIO_MODEL,
        api_key='lm-studio',
        temperature=0.0,
        parallel_tool_calls=True,
        optimization_preset='generic',
        max_output_tokens=0,
    )
    return RuntimeConfig(
        active_connection_id=openai_connection.id,
        connections=[openai_connection, lmstudio_connection],
        audio=RuntimeAudioConfig(
            provider='whisper',
            base_url='',
            model=DEFAULT_WHISPER_MODEL,
            api_key='',
        ),
        host=RuntimeHostConfig(),
        tools=RuntimeToolsConfig(
            edit_tools_strict=CLARA_EDIT_TOOLS_STRICT,
            max_file_read_lines=MAX_FILE_READ_LINES,
            max_search_results=MAX_SEARCH_RESULTS,
        ),
    )


# Live settings; replaced entirely when the client POSTs /runtime-config.
runtime_config: RuntimeConfig = build_default_runtime_config()


def touch_session(sess: SessionState, *, now: float | None = None) -> None:
    """Mark a session as recently used (blocks idle eviction)."""
    sess.last_touched = time.time() if now is None else now


def _session_is_idle_evictable(sid: str, sess: SessionState, *, now: float, protected: str) -> bool:
    if sid == protected:
        return False
    if sess.agent_pause_event is not None:
        return False
    if sess.active_langgraph_agent_streams > 0:
        return False
    touched = float(sess.last_touched or 0.0)
    if touched <= 0.0:
        return True
    return (now - touched) >= SESSION_IDLE_TTL_SEC


async def _async_teardown_after_evict(sid: str) -> None:
    from clara_coder_backend.session.lifecycle import teardown_session

    try:
        await teardown_session(sid)
    except Exception:
        logger.debug('async teardown after idle eviction failed sid=%s', sid, exc_info=True)


def prune_idle_sessions(*, now: float | None = None) -> list[str]:
    """Drop idle sessions (no pause, no active streams, older than TTL).

    Never evicts ``current_session_id``. Pops from ``sessions`` immediately; schedules
    full async teardown (checkpoints / bg commands) when an event loop is running.
    Returns evicted session ids.
    """
    global _pruning
    if _pruning:
        # Re-entered from eviction cleanup (cleanup -> get_session -> prune): the
        # outer prune already owns this pass; recursing here never terminates.
        return []

    ts = time.time() if now is None else now
    protected = (current_session_id.get() or '').strip()
    to_evict = [
        sid
        for sid, sess in list(sessions.items())
        if _session_is_idle_evictable(sid, sess, now=ts, protected=protected)
    ]
    if not to_evict:
        return []

    from clara_coder_backend.workspace_index.lifecycle import invalidate_staging_index_disk

    loop: asyncio.AbstractEventLoop | None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    _pruning = True
    try:
        for sid in to_evict:
            sess = sessions.get(sid)
            if sess is None:
                continue
            try:
                invalidate_staging_index_disk(sid)
            except Exception:
                logger.debug('invalidate staging index on idle eviction failed', exc_info=True)
            sessions.pop(sid, None)
            if loop is not None:
                loop.create_task(_async_teardown_after_evict(sid))
            logger.info('evicted idle session sid=%s', sid)
    finally:
        _pruning = False
    return to_evict


def get_session(session_id: str) -> SessionState:
    """Return existing session state or create an empty one for this id."""
    if len(sessions) > SESSION_PRUNE_THRESHOLD:
        prune_idle_sessions()
    sess = sessions.setdefault(session_id, SessionState())
    touch_session(sess)
    return sess


def agent_formatters_enabled() -> bool:
    """True when Settings → Tools allows Black/Prettier in the agent flow (auto + format tools)."""
    return bool(getattr(runtime_config.tools, 'enable_agent_formatters', False))


def mutation_tools_blocked_reason(session_id: str | None = None) -> str | None:
    """Return an error when mutation-capable tools are used while Editor mode is off."""
    sid = (session_id or current_session_id.get() or '').strip()
    if not sid:
        return 'Tool error: no active session.'
    sess = get_session(sid)
    if not sess.worker_apply_mode:
        return 'Tool error: Editor mode is off; workspace mutation tools are unavailable.'
    return None


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
