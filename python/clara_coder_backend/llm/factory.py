"""Construct a LangChain ChatOpenAI client from the active runtime connection.

Uses the ``openai`` Python package (via ``langchain-openai``) against OpenAI-compatible endpoints.
:class:`~langchain_openai.ChatOpenAI` is configured with ``stream_usage=True`` so streaming runs request
``stream_options: {include_usage: true}`` and completed assistant turns carry LangChain
:class:`~langchain_core.messages.AIMessage.usage_metadata` (prompt, completion, and total tokens) where the
server supports it (OpenAI, LM Studio, recent ``llama-server``, etc.).

Supports OpenAI's API, OpenRouter, LM Studio, and llama.cpp’s OpenAI-compatible HTTP server. Streaming is
enabled for token-by-token :meth:`~langchain_core.language_models.chat_models.BaseChatModel.astream`.
Optional ``reasoning_effort`` is passed through for models that support it
(``none|minimal|low|medium|high|xhigh`` on current OpenAI-style APIs). UI values ``on`` / ``off``
are mapped to ``medium`` / ``none`` so the wire value is always API-valid.
``clara_coder_backend.llm.model_tuning`` may add ``max_tokens`` when Settings max output is positive
(or an explicit env cap is set), optional per-preset sampling from Settings (``top_p``, ``top_k``, ``min_p``, ``presence_penalty``,
``repeat_penalty``), and Gemma-specific ``top_p`` / ``top_k`` via the Gemma sampling preset (merging ``extra_body``
for locals such as LM Studio / ``llama-server``). OpenAI-style ``reasoning_effort`` is omitted when live
Jinja caps omit it, or when the Gemma template is active without caps (use thinking settings instead).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx
from fastapi import HTTPException
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI

from clara_coder_backend.config import (
    env_clara,
    DEFAULT_LLAMACPP_BASE_URL,
    DEFAULT_LM_STUDIO_BASE_URL,
    DEFAULT_OPENROUTER_BASE_URL,
)
from clara_coder_backend.logging.llm_interaction_logging import log_llm_connection_settings
from clara_coder_backend.llm.http_transport import acquire_llm_http_clients
from clara_coder_backend.runtime.http_url_normalize import normalize_openai_api_base
from clara_coder_backend.llm.gemma_output import GEMMA_CHANNEL_LOOP_STOP
from clara_coder_backend.llm.model_tuning import (
    connection_exposes_reasoning_effort,
    connection_user_sampling_kwargs_for_llm,
    gemma_enable_thinking_for_llm,
    gemma_optimize_profile_active,
    gemma_sampling_kwargs_for_llm,
    llm_optional_kwargs,
)
from clara_coder_backend.session.state import get_active_connection, require_openai_api_key

logger = logging.getLogger('clara.llm')

# OpenAI (and aligned gateways) reject arbitrary strings; ``on``/``off`` are app UI aliases only.
_REASONING_API_VALUES = frozenset({'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'})

# llama.cpp / LM Studio fields. OpenRouter forwards unknown body fields and upstreams reject them.
# Clara builds these itself; overriding them would break the agent loop.
_COMPAT_RESERVED_BODY_KEYS = frozenset({'model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options'})
_LLAMA_EXTRA_BODY_KEYS = ('top_k', 'min_p', 'repeat_penalty', 'chat_template_kwargs')

# OpenRouter app attribution (rankings). ``HTTP-Referer`` is the app id; title is the display name.
OPENROUTER_HTTP_REFERER = 'https://clara.coder'
OPENROUTER_APP_TITLE = 'Clara Coder'

# Idle (inter-token) read timeout so a stalled stream surfaces as an error instead of an infinite
# silent hang. httpx ``read`` governs the max wait between received chunks, so this does NOT cap the
# total generation time of a legitimately long response. Override with ``CLARA_LLM_IDLE_TIMEOUT_SEC``.
_DEFAULT_LLM_IDLE_TIMEOUT_SEC = 900.0


def llm_idle_timeout_sec() -> float:
    """Resolve the idle/inter-token read timeout (seconds) from env, with a safe default."""
    raw = (env_clara('CLARA_LLM_IDLE_TIMEOUT_SEC', '') or '').strip()
    if not raw:
        return _DEFAULT_LLM_IDLE_TIMEOUT_SEC
    try:
        value = float(raw)
    except ValueError:
        logger.warning('Invalid CLARA_LLM_IDLE_TIMEOUT_SEC=%r; using default %.0fs', raw, _DEFAULT_LLM_IDLE_TIMEOUT_SEC)
        return _DEFAULT_LLM_IDLE_TIMEOUT_SEC
    # Guard against accidental 0 / negative values that would disable or break the timeout.
    return value if value > 0 else _DEFAULT_LLM_IDLE_TIMEOUT_SEC


def _resolve_reasoning_effort(raw: str) -> str | None:
    """Return ``reasoning_effort`` to send to the API, or ``None`` to omit the parameter."""
    e = (raw or '').strip().lower()
    if not e:
        return None
    if e == 'on':
        return 'medium'
    if e == 'off':
        return 'none'
    if e in _REASONING_API_VALUES:
        return e
    return None


def _off_reasoning_effort(allowed: list[str] | None) -> str | None:
    """Lowest/off OpenAI-style effort value, or ``None`` when the allow-list forbids it."""
    if allowed is None:
        return 'none'
    if 'none' in allowed:
        return 'none'
    if 'minimal' in allowed:
        return 'minimal'
    return None


def _apply_openai_compatible(kwargs: dict[str, Any], connection: RuntimeConnection, *, disable_thinking: bool) -> None:
    """Rebuild the request for a generic server: only standard fields, plus what its settings say it accepts."""
    compat = connection.open_ai_compat or {}
    extra: dict[str, Any] = {}
    kwargs.pop('reasoning_effort', None)
    kwargs.pop('extra_body', None)

    # LangChain always sends its ``max_tokens`` as ``max_completion_tokens``, so the other field goes in the body.
    cap = kwargs.pop('max_tokens', None)
    if cap:
        if compat.get('tokensField') == 'max_completion_tokens':
            kwargs['max_tokens'] = cap
        else:
            extra['max_tokens'] = cap

    if not compat.get('sendTemperature', True):
        kwargs['temperature'] = None
    kwargs['stream_usage'] = bool(compat.get('streamUsage', True))
    if compat.get('frequencyPenalty') is not None:
        kwargs['frequency_penalty'] = float(compat['frequencyPenalty'])
    if compat.get('seed') is not None:
        kwargs['seed'] = int(compat['seed'])
    if compat.get('stop'):
        kwargs['stop'] = [*(kwargs.get('stop') or []), *compat['stop']]

    if compat.get('nonStandardSampling'):
        extra.update(connection_user_sampling_kwargs_for_llm(connection).get('extra_body') or {})

    method = compat.get('thinkingMethod') or 'none'
    mode = (connection.thinking_mode or 'default').strip().lower()
    off = disable_thinking or mode == 'off'
    effort = (connection.reasoning_effort or '').strip().lower()
    if method == 'reasoning_effort' and (off or effort):
        kwargs['reasoning_effort'] = 'none' if off else effort
    elif method == 'reasoning' and (off or effort):
        extra['reasoning'] = {'effort': 'none' if off else effort}
    elif method == 'chat_template_kwargs' and (off or mode == 'on'):
        extra['chat_template_kwargs'] = {'enable_thinking': not off}

    extra.update(_compat_extra_body(compat.get('extraBody') or ''))
    if extra:
        kwargs['extra_body'] = extra
    if connection.custom_headers:
        kwargs['default_headers'] = dict(connection.custom_headers)


def _compat_extra_body(text: str) -> dict[str, Any]:
    """The user's extra request body. Settings validates it; a bad one is skipped rather than breaking chat."""
    if not text.strip():
        return {}
    try:
        parsed = json.loads(text)
    except ValueError:
        logger.warning('Ignoring the extra request body: not valid JSON')
        return {}
    if not isinstance(parsed, dict):
        logger.warning('Ignoring the extra request body: not a JSON object')
        return {}
    return {k: v for k, v in parsed.items() if k not in _COMPAT_RESERVED_BODY_KEYS}


def build_llm(*, disable_thinking: bool = False) -> BaseChatModel:
    """Build the chat model for the agent (tools bound separately): ``ChatOpenAI`` for
    OpenAI-compatible sources, ``ChatAnthropic`` for Claude (see :mod:`.anthropic_llm`).

    Streaming is enabled so :meth:`~langchain_core.language_models.chat_models.BaseChatModel.astream`
    yields token chunks; the agent loop forwards them as SSE while still assembling full turns
    for tool calling.

    ``disable_thinking=True`` pins thinking/reasoning off for this client only (title
    suggestion, Clara's first-turn briefing, and similar one-shot calls), for known
    and unknown models. Local
    OpenAI-compatible servers get ``chat_template_kwargs.enable_thinking=false`` even
    when live Jinja caps are missing; OpenAI-style ``reasoning_effort`` is set to
    ``none`` (or ``minimal``) when that knob is exposed.
    """
    connection = get_active_connection()
    if connection.provider == 'anthropic':
        # Imported here so OpenAI-compatible sources never pay for the Anthropic SDK import.
        from clara_coder_backend.llm.anthropic_llm import build_anthropic_llm

        return build_anthropic_llm(connection, idle_timeout_sec=llm_idle_timeout_sec(), disable_thinking=disable_thinking)

    base_url = connection.base_url
    api_key = connection.api_key

    if connection.provider == 'openai':
        api_key = api_key or os.getenv('OPENAI_API_KEY', '')
        require_openai_api_key(api_key, 'OpenAI')
    elif connection.provider == 'lmstudio':
        base_url = (
            normalize_openai_api_base(connection.base_url or DEFAULT_LM_STUDIO_BASE_URL) or DEFAULT_LM_STUDIO_BASE_URL
        )
        api_key = connection.api_key or os.getenv('LM_STUDIO_API_KEY', 'lm-studio')
    elif connection.provider == 'llamacpp':
        base_url = (
            normalize_openai_api_base(connection.base_url or DEFAULT_LLAMACPP_BASE_URL) or DEFAULT_LLAMACPP_BASE_URL
        )
        api_key = connection.api_key or os.getenv('LLAMACPP_API_KEY', 'not-needed')
    elif connection.provider == 'openai-compatible':
        if not (base_url or '').strip():
            # Without a URL the client would default to OpenAI, sending this key somewhere unintended.
            raise HTTPException(status_code=400, detail='Add a base URL for this source in Settings.')
        # The client requires a value; many local servers ignore it.
        api_key = api_key or 'not-needed'
    elif connection.provider == 'openrouter':
        api_key = api_key or os.getenv('OPENROUTER_API_KEY', '')
        require_openai_api_key(api_key, 'OpenRouter')
        base_url = (
            normalize_openai_api_base(connection.base_url or DEFAULT_OPENROUTER_BASE_URL) or DEFAULT_OPENROUTER_BASE_URL
        )
    else:
        logger.error('Unsupported LLM provider: %s', connection.provider)
        raise HTTPException(status_code=500, detail=f'Unsupported LLM provider: {connection.provider}')

    idle_sec = llm_idle_timeout_sec()
    timeout = httpx.Timeout(connect=30.0, read=idle_sec, write=60.0, pool=30.0)
    http_client, http_async_client = acquire_llm_http_clients(timeout)
    kwargs: dict[str, Any] = {
        'model': connection.model,
        'temperature': float(connection.temperature),
        'streaming': True,
        # LangChain passes ``stream_options: {include_usage: true}`` to the OpenAI SDK so streaming
        # completions include usage chunks (OpenAI + many OpenAI-compatible servers, e.g. llama-server).
        # Without this, custom ``base_url`` disables stream_usage by default.
        'stream_usage': True,
        # Idle read timeout: a stalled stream (socket open, no tokens) raises httpx.ReadTimeout instead
        # of hanging the SSE stream forever. ``read`` is per-chunk, so long generations are unaffected.
        'timeout': timeout,
        # Owned clients with response hooks so Stop can cancel the in-flight generation
        # request without disposing the client or stopping llama-server.
        'http_client': http_client,
        'http_async_client': http_async_client,
        # langchain-openai defaults ``stream_chunk_timeout`` to 120s. Local llama.cpp often emits one
        # SSE opening chunk, then stays silent through prompt eval / thinking after a tool result —
        # that is not a dead connection. Keep this aligned with the httpx idle read timeout.
        'stream_chunk_timeout': idle_sec,
        # Fail fast on a stalled/timed-out stream rather than silently re-attempting in the background.
        'max_retries': 0,
    }
    if base_url:
        kwargs['base_url'] = base_url
    if api_key:
        kwargs['api_key'] = api_key

    # Per-connection UI setting, with env fallback for headless/dev use.
    # Live Jinja caps (when present) decide whether effort is sent; otherwise Gemma omits it.
    thinking_mode = (getattr(connection, 'thinking_mode', None) or 'default').strip().lower()
    effort_caps = getattr(connection, 'chat_template_reasoning', None)
    # OpenRouter caps come from the model catalog: ``enableThinking`` means reasoning is optional.
    openrouter_reasoning_optional = (
        connection.provider == 'openrouter' and isinstance(effort_caps, dict) and bool(effort_caps.get('enableThinking'))
    )
    user_thinking_off = thinking_mode == 'off'
    if connection.provider == 'openrouter' and isinstance(effort_caps, dict) and not openrouter_reasoning_optional:
        # No off switch for this model (mandatory reasoning, or none): a saved ``off`` must not
        # also drop the effort the user picked.
        user_thinking_off = False
    thinking_off = disable_thinking or user_thinking_off
    allowed = effort_caps.get('reasoningEffortValues') if isinstance(effort_caps, dict) else None
    if not isinstance(allowed, list):
        allowed = None
    if connection_exposes_reasoning_effort(connection) and disable_thinking:
        off_effort = _off_reasoning_effort(allowed)
        if off_effort is not None:
            kwargs['reasoning_effort'] = off_effort
    elif connection_exposes_reasoning_effort(connection) and not thinking_off:
        effort_raw = (connection.reasoning_effort or '').strip().lower()
        if not effort_raw:
            effort_raw = (env_clara('CLARA_REASONING_EFFORT', '') or '').strip().lower()
        resolved = _resolve_reasoning_effort(effort_raw)
        if resolved is not None and (allowed is None or resolved in allowed):
            kwargs['reasoning_effort'] = resolved

    if connection.provider == 'lmstudio' and thinking_off:
        # ``/v1/chat/completions`` ignores ``enable_thinking``; ``none`` is what turns thinking off.
        kwargs['reasoning_effort'] = 'none'

    kwargs.update(llm_optional_kwargs(connection))

    user_sampling = connection_user_sampling_kwargs_for_llm(connection)
    eb_user = user_sampling.pop('extra_body', None)
    if eb_user:
        base_eb = dict(kwargs.get('extra_body') or {})
        base_eb.update(eb_user)
        kwargs['extra_body'] = base_eb
    kwargs.update(user_sampling)

    gemma_sampling = gemma_sampling_kwargs_for_llm(connection)
    eb_extra = gemma_sampling.pop('extra_body', None)
    if eb_extra:
        base_eb = dict(kwargs.get('extra_body') or {})
        base_eb.update(eb_extra)
        kwargs['extra_body'] = base_eb
    kwargs.update(gemma_sampling)

    ctk_updates: dict[str, Any] = {}
    if disable_thinking:
        # Always pin boolean thinking off for llama.cpp / LM Studio / unknown templates.
        # Skip OpenAI and OpenRouter (unknown extra_body fields 400).
        if connection.provider not in ('openai', 'openrouter'):
            ctk_updates['enable_thinking'] = False
    else:
        enable_thinking = gemma_enable_thinking_for_llm(connection)
        if enable_thinking is not None:
            ctk_updates['enable_thinking'] = enable_thinking
    caps = getattr(connection, 'chat_template_reasoning', None)
    if isinstance(caps, dict) and 'reasoning_effort' in kwargs:
        ctk_updates['reasoning_effort'] = kwargs['reasoning_effort']
    if ctk_updates:
        base_eb = dict(kwargs.get('extra_body') or {})
        ctk = dict(base_eb.get('chat_template_kwargs') or {})
        ctk.update(ctk_updates)
        base_eb['chat_template_kwargs'] = ctk
        kwargs['extra_body'] = base_eb

    if connection.provider in ('llamacpp', 'lmstudio', 'openai-compatible') and gemma_optimize_profile_active(connection):
        kwargs['stop'] = [GEMMA_CHANNEL_LOOP_STOP]

    idle_ttl = int(getattr(connection, 'idle_ttl_seconds', 0) or 0)
    if connection.provider == 'lmstudio' and idle_ttl > 0:
        base_eb = dict(kwargs.get('extra_body') or {})
        base_eb['ttl'] = idle_ttl
        kwargs['extra_body'] = base_eb

    if connection.provider == 'openrouter':
        effort = kwargs.pop('reasoning_effort', None)
        eb = dict(kwargs.get('extra_body') or {})
        for key in _LLAMA_EXTRA_BODY_KEYS:
            eb.pop(key, None)
        if thinking_off and openrouter_reasoning_optional:
            # OpenRouter's off switch; mandatory-reasoning models reject it, hence the guard.
            effort = 'none'
        if isinstance(effort, str) and effort.strip():
            eb['reasoning'] = {'effort': effort.strip()}
        elif thinking_mode == 'on' and openrouter_reasoning_optional:
            # Toggle explicitly on with Default effort: some models only reason when asked.
            eb['reasoning'] = {'enabled': True}
        if eb:
            kwargs['extra_body'] = eb
        else:
            kwargs.pop('extra_body', None)
        kwargs['default_headers'] = {
            'HTTP-Referer': OPENROUTER_HTTP_REFERER,
            'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
        }

    if connection.provider == 'openai-compatible':
        _apply_openai_compatible(kwargs, connection, disable_thinking=disable_thinking)

    safe: dict[str, Any] = {
        'provider': connection.provider,
        'model': kwargs['model'],
        'temperature': kwargs['temperature'],
        'base_url': kwargs.get('base_url'),
        'api_key_configured': bool(kwargs.get('api_key')),
        'streaming': kwargs.get('streaming'),
    }
    if 'reasoning_effort' in kwargs:
        safe['reasoning_effort'] = kwargs['reasoning_effort']
    timeout_obj = kwargs.get('timeout')
    if isinstance(timeout_obj, httpx.Timeout):
        safe['idle_read_timeout_sec'] = timeout_obj.read
    if 'stream_chunk_timeout' in kwargs:
        safe['stream_chunk_timeout_sec'] = kwargs['stream_chunk_timeout']
    for k, v in kwargs.items():
        if k in (
            'api_key',
            'model',
            'temperature',
            'streaming',
            'base_url',
            'reasoning_effort',
            'timeout',
            'stream_chunk_timeout',
            'http_client',
            'http_async_client',
            'default_headers',
        ):
            continue
        # A custom request body can hold anything the user put there.
        if k == 'extra_body' and connection.provider == 'openai-compatible':
            continue
        safe[k] = v
    log_llm_connection_settings(safe)

    return ChatOpenAI(**kwargs)
