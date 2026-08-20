"""Heuristic tuning for optimization presets (Qwen, Gemma, Generic).

The desktop **Optimization template** (``optimization_preset`` on the active connection) selects
which profile is active. Model ids alone do **not** enable Qwen or Gemma profiles; pick **qwen** or
**gemma** in Settings when you want those behaviors.

**Gemma** (LM Studio / OpenAI-compatible): use the **gemma** template. Thinking is boolean (``thinking_mode``),
not OpenAI ``reasoning_effort`` tiers. Recommended ``temperature`` / ``top_p`` / ``top_k`` are written onto
the connection when the template is selected; inference uses those connection fields directly.
Gemma does not add extra system-prompt notes.

``max_output_tokens`` on the connection sets API ``max_tokens`` when positive. ``0`` omits
``max_tokens`` (no Clara-side cap; the server context window still limits prompt plus completion).
Optional env ``CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS`` / ``CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS``
only apply when explicitly set. Global env ``CLARA_CHAT_MAX_OUTPUT_TOKENS`` still wins for all models
when set and positive.
"""

from __future__ import annotations

from clara_coder_backend.config import env_clara

import os
from typing import Any

from clara_coder_backend.domain import RuntimeConnection
from clara_coder_backend.session.state import runtime_config


def is_qwen_family(model: str) -> bool:
    """True when the configured model id is likely Qwen (local or API)."""
    return 'qwen' in (model or '').lower()


def is_qwen35_vision_model(model: str) -> bool:
    """True when the model id is likely a natively multimodal Qwen3.5 variant (e.g. qwen3.5-27b)."""
    normalized = (model or '').lower().replace('_', '-')
    return 'qwen3.5' in normalized or 'qwen3-5' in normalized or 'qwen-3.5' in normalized


def is_gemma_family(model: str) -> bool:
    """True when the configured model id is likely Google Gemma (local or API)."""
    return 'gemma' in (model or '').lower()


def optimization_preset(connection: RuntimeConnection) -> str:
    return (getattr(connection, 'optimization_preset', None) or 'generic').strip().lower()


def qwen_optimize_profile_active(connection: RuntimeConnection) -> bool:
    """True when the Qwen optimization template is selected."""
    return optimization_preset(connection) == 'qwen'


def gemma_optimize_profile_active(connection: RuntimeConnection) -> bool:
    """True when the Gemma optimization template is selected."""
    return optimization_preset(connection) == 'gemma'


def gemma_output_parsing_active(connection: RuntimeConnection) -> bool:
    """True when Gemma 4 ``<|channel>`` output should be split into reasoning vs visible text."""
    return gemma_optimize_profile_active(connection)


def gemma_enable_thinking_for_llm(connection: RuntimeConnection) -> bool | None:
    """Map Settings ``thinking_mode`` to llama-server ``chat_template_kwargs.enable_thinking``.

    Live Jinja caps win when present. Without caps, Gemma and Qwen presets send boolean thinking.
    """
    return enable_thinking_kwarg_for_llm(connection)


def _connection_exposes_enable_thinking(connection: RuntimeConnection) -> bool:
    """True when ``enable_thinking`` should be sent for this connection."""
    caps = getattr(connection, 'chat_template_reasoning', None)
    if isinstance(caps, dict):
        if caps.get('enableThinking'):
            return True
        return optimization_preset(connection) == 'qwen' and caps.get('reasoningEffortValues') is not None
    return gemma_optimize_profile_active(connection) or qwen_optimize_profile_active(connection)


def enable_thinking_kwarg_for_llm(connection: RuntimeConnection) -> bool | None:
    """Return ``enable_thinking`` for ``chat_template_kwargs``, or ``None`` to omit it."""
    if not _connection_exposes_enable_thinking(connection):
        return None
    mode = (getattr(connection, 'thinking_mode', None) or 'default').strip().lower()
    if mode == 'on':
        return True
    if mode == 'off':
        return False
    return None


def connection_exposes_reasoning_effort(connection: RuntimeConnection) -> bool:
    """True when OpenAI-style ``reasoning_effort`` should be sent for this connection."""
    caps = getattr(connection, 'chat_template_reasoning', None)
    if isinstance(caps, dict):
        return caps.get('reasoningEffortValues') is not None
    return not gemma_optimize_profile_active(connection)


def effective_parallel_tool_calls(connection: RuntimeConnection) -> bool:
    """Whether the API request should allow multiple tool calls in one completion."""
    return bool(connection.parallel_tool_calls)


def connection_user_sampling_kwargs_for_llm(connection: RuntimeConnection) -> dict[str, Any]:
    """Map explicit Settings sampling fields to ``ChatOpenAI`` kwargs / ``extra_body``.

    ``top_p`` uses the standard Chat Completions field. ``top_k``, ``min_p``, and
    ``repeat_penalty`` are sent in ``extra_body`` for OpenAI-compatible locals
    (e.g. llama.cpp ``llama-server``); ``presence_penalty`` uses the standard field.
    """
    out: dict[str, Any] = {}
    extra: dict[str, Any] = {}

    tp = getattr(connection, 'top_p', None)
    tk = getattr(connection, 'top_k', None)
    if tp is not None:
        out['top_p'] = float(tp)
    if tk is not None:
        extra['top_k'] = int(tk)

    mnp = getattr(connection, 'min_p', None)
    if mnp is not None:
        extra['min_p'] = float(mnp)

    pr = getattr(connection, 'presence_penalty', None)
    if pr is not None:
        out['presence_penalty'] = float(pr)

    rpen = getattr(connection, 'repeat_penalty', None)
    if rpen is not None:
        extra['repeat_penalty'] = float(rpen)

    if extra:
        out['extra_body'] = extra
    return out


def gemma_sampling_kwargs_for_llm(connection: RuntimeConnection) -> dict[str, Any]:
    """Deprecated no-op: Gemma sampling is applied via connection ``top_p`` / ``top_k``.

    Kept for call-site compatibility; Settings writes recommended values onto the
    connection when the Gemma template is selected.
    """
    _ = connection
    return {}


def llm_optional_kwargs(connection: RuntimeConnection) -> dict[str, Any]:
    """Extra ``ChatOpenAI`` kwargs (e.g. ``max_tokens``) derived from env, connection, then preset profiles."""
    out: dict[str, Any] = {}
    global_max = env_clara('CLARA_CHAT_MAX_OUTPUT_TOKENS', '').strip()
    if global_max.isdigit():
        v = int(global_max)
        if v > 0:
            out['max_tokens'] = v
        return out
    conn_max = int(getattr(connection, 'max_output_tokens', 0) or 0)
    if conn_max > 0:
        out['max_tokens'] = conn_max
        return out
    # Settings 0 = no max_tokens. Preset env caps apply only when explicitly set.
    if qwen_optimize_profile_active(connection):
        raw = env_clara('CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS', '').strip()
        if raw.isdigit():
            default_max = int(raw)
            if default_max > 0:
                out['max_tokens'] = default_max
        return out
    if gemma_optimize_profile_active(connection):
        raw = env_clara('CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS', '').strip()
        if raw.isdigit():
            default_max = int(raw)
            if default_max > 0:
                out['max_tokens'] = default_max
        return out
    return out


def tool_calling_and_edit_semantics_suffix(
    _connection: RuntimeConnection | None = None,
    *,
    direct_workspace_edits: bool = False,
) -> str:
    """API tool-channel reminder only.

    Edit semantics and discovery policy live once in ``edit_semantics_block`` /
    ``messages._outer_agent_operational_block``. ``direct_workspace_edits`` is kept for
    call-site compatibility and intentionally unused.
    """
    _ = direct_workspace_edits
    return (
        '\n\nModel note (tools): Never put tool arguments or <tool_call> XML in plain assistant text—'
        'only use the API tool channel.\n'
    )


def parallel_batching_prompt_suffix() -> str:
    """When parallel tool calls are enabled, encourage batching independent reads in one completion."""
    return (
        '\nModel note (parallel tools): When the API allows multiple tool calls in one completion, you may batch '
        'independent read, search, or LSP inspection calls together in a single turn.\n'
    )


def qwen_specific_prompt_suffix() -> str:
    """Qwen-family staging/transfer discipline; use with :func:`tool_calling_and_edit_semantics_suffix`."""
    return (
        '\nModel note (Qwen): When staging review applies, land approved drafts with '
        '**`land_in_workspace=true`** on your final stage/LSP call, or `transfer_staged_file_to_workspace` for '
        'already-staged paths—do not ask the user to approve or apply the diff in the UI instead of using the tool.\n'
    )


def qwen_vision_prompt_suffix(connection: RuntimeConnection) -> str:
    """Hint to use ``read_workspace_image`` when Qwen preset is active on a Qwen3.5 vision model."""
    if not qwen_optimize_profile_active(connection):
        return ''
    if not is_qwen35_vision_model(connection.model):
        return ''
    return (
        '\nModel note (Qwen vision): For PNG/JPEG/GIF/WebP/BMP in the workspace, call '
        '`read_workspace_image` with the relative path. The tool attaches the image for visual analysis '
        '(OCR, diagrams, UI screenshots). Optional `focus` narrows what to inspect. '
        'When the user attaches an image in chat, a vision turn is injected automatically; you may also '
        'call `read_workspace_image` using the path from the `Attached image:` line to re-open it later.\n'
    )


def qwen_system_prompt_suffix(connection: RuntimeConnection | None = None) -> str:
    """Backward-compatible name: full Qwen block equals universal semantics plus Qwen-only lines."""
    return tool_calling_and_edit_semantics_suffix(connection) + qwen_specific_prompt_suffix()


def combined_model_prompt_suffix(
    connection: RuntimeConnection,
    *,
    session: object | None = None,
    apply_mode: bool = False,
) -> str:
    """Tool-channel reminder plus optional parallel / Qwen notes.

    Gemma uses inference settings and chat-template parsing only—no extra prompt notes.
    ``session`` / ``apply_mode`` are kept for call-site compatibility; edit semantics are
    assembled once in ``build_system_prompt`` operational guidance.
    """
    _ = session, apply_mode
    parts = [tool_calling_and_edit_semantics_suffix(connection)]
    if effective_parallel_tool_calls(connection):
        parts.append(parallel_batching_prompt_suffix())
    if qwen_optimize_profile_active(connection):
        parts.append(qwen_specific_prompt_suffix())
        parts.append(qwen_vision_prompt_suffix(connection))
    return ''.join(parts)
