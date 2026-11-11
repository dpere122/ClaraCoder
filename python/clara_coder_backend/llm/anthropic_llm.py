"""Construct a LangChain ``ChatAnthropic`` client for the Claude source.

``ChatAnthropic`` (``langchain-anthropic``) calls the Messages API through the official
``anthropic`` SDK. Request shape, per the active model's Models API capabilities (Electron
sends them as ``chat_template_reasoning``):

- Adaptive thinking with summarized display when the model supports it, so reasoning streams
  into the reasoning panel; effort is the only depth control (current models cannot turn
  thinking off). ``disable_thinking`` one-shot calls drop to ``low`` effort instead.
- ``thinking.block_binding.prefix_mismatch_behavior = "drop_block"``: Clara compacts and rebuilds
  history between turns, which invalidates earlier thinking blocks. Dropping them degrades to
  "no earlier reasoning" instead of a 400 on accounts where the history check is enforced.
- Top-level automatic prompt caching (``cache_control``), so the system prompt and tool list are
  billed at cache rates on every agent step after the first.
- No sampling parameters (current Claude models reject them).
"""

from __future__ import annotations

import logging
import os
from functools import cached_property
from typing import Any

import anthropic
from fastapi import HTTPException
from langchain_anthropic import ChatAnthropic

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.llm.http_transport import acquire_anthropic_http_clients
from clara_coder_backend.llm.model_tuning import llm_optional_kwargs
from clara_coder_backend.logging.llm_interaction_logging import log_llm_connection_settings
from clara_coder_backend.session.state import require_openai_api_key

logger = logging.getLogger('clara.llm.anthropic')

# Streaming keeps a large cap safe from HTTP timeouts; Settings' max output (when set) wins.
ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 64_000
# Lets the request set ``thinking.block_binding`` (drop invalidated thinking blocks, not 400).
THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01'


class ClaraChatAnthropic(ChatAnthropic):
    """``ChatAnthropic`` on Clara's owned ``httpx2`` clients, so Stop can close the live stream."""

    request_timeout_sec: float = 600.0

    @cached_property
    def _client(self) -> anthropic.Client:
        sync_client, _ = acquire_anthropic_http_clients(self.request_timeout_sec)
        return anthropic.Client(**self._client_params, http_client=sync_client)

    @cached_property
    def _async_client(self) -> anthropic.AsyncClient:
        _, async_client = acquire_anthropic_http_clients(self.request_timeout_sec)
        return anthropic.AsyncClient(**self._client_params, http_client=async_client)


def resolve_anthropic_effort(saved: str, allowed: list[str] | None, *, disable_thinking: bool) -> str | None:
    """Effort to send: what the composer shows (saved if offered, else ``medium``, else the first).

    ``disable_thinking`` (titles, briefings) asks for the lowest offered level. ``None`` when the
    model has no effort control.
    """
    if not allowed:
        return None
    if disable_thinking:
        return 'low' if 'low' in allowed else allowed[0]
    effort = (saved or '').strip().lower()
    if effort in allowed:
        return effort
    return 'medium' if 'medium' in allowed else allowed[0]


def build_anthropic_llm(
    connection: RuntimeConnection,
    *,
    idle_timeout_sec: float,
    disable_thinking: bool = False,
) -> ClaraChatAnthropic:
    """Build the Claude chat model for ``connection`` (provider ``anthropic``)."""
    api_key = connection.api_key or os.getenv('ANTHROPIC_API_KEY', '')
    require_openai_api_key(api_key, 'Claude')
    model = (connection.model or '').strip()
    if not model:
        raise HTTPException(status_code=500, detail='Pick a Claude model in Settings → Sources → Claude.')

    caps = connection.chat_template_reasoning if isinstance(connection.chat_template_reasoning, dict) else {}
    allowed_raw = caps.get('reasoningEffortValues')
    allowed = [str(v) for v in allowed_raw] if isinstance(allowed_raw, list) else None
    adaptive = bool(caps.get('adaptiveThinking'))

    max_tokens = int(llm_optional_kwargs(connection).get('max_tokens') or ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS)
    kwargs: dict[str, Any] = {
        'model': model,
        'api_key': api_key,
        'max_tokens': max_tokens,
        'streaming': True,
        'stream_usage': True,
        # Fail fast on a stalled stream rather than silently re-attempting in the background.
        'max_retries': 0,
        # Per-read idle timeout on the owned httpx2 clients (a long generation keeps streaming).
        'request_timeout_sec': float(idle_timeout_sec),
        'model_kwargs': {'cache_control': {'type': 'ephemeral'}},
    }
    if adaptive:
        kwargs['thinking'] = {
            'type': 'adaptive',
            'display': 'summarized',
            'block_binding': {'prefix_mismatch_behavior': 'drop_block'},
        }
        kwargs['betas'] = [THINKING_BINDING_BETA]
    effort = resolve_anthropic_effort(connection.reasoning_effort or '', allowed, disable_thinking=disable_thinking)
    if effort:
        kwargs['output_config'] = {'effort': effort}

    log_llm_connection_settings(
        {
            'provider': 'anthropic',
            'model': model,
            'api_key_configured': True,
            'streaming': True,
            'max_tokens': max_tokens,
            'thinking': 'adaptive' if adaptive else 'default',
            'effort': effort,
            'betas': kwargs.get('betas'),
            'idle_read_timeout_sec': idle_timeout_sec,
        }
    )
    return ClaraChatAnthropic(**kwargs)
