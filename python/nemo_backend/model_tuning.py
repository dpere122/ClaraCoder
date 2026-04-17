"""Heuristic tuning for optimization presets (Qwen, Capable API, Gemma, etc.).

The desktop **Optimization template** (``optimization_preset`` on the active connection) selects
which profile is active. Model ids alone do **not** enable Qwen or Gemma profiles; pick **qwen** or
**gemma** in Settings when you want those behaviors.

The **capable** preset turns on parallel tool calls by default (UI) and appends batching hints in the system prompt.

**Gemma** (LM Studio / OpenAI-compatible): use the **gemma** template. Thinking is boolean (``thinking_mode``),
not OpenAI ``reasoning_effort`` tiers. Sampling can follow Google's recommended ``temperature`` /
``top_p`` / ``top_k`` via ``sampling_preset``.

``max_output_tokens`` on the connection sets API ``max_tokens`` when positive; otherwise preset/env
defaults apply. Global env ``NEMO_CHAT_MAX_OUTPUT_TOKENS`` still wins for all models.
"""

from __future__ import annotations

import os
from typing import Any

from nemo_backend.domain import RuntimeConnection


def is_qwen_family(model: str) -> bool:
    """True when the configured model id is likely Qwen (local or API)."""
    return 'qwen' in (model or '').lower()


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


def effective_architecture_hint(connection: RuntimeConnection) -> str:
    """Return ``dense`` or ``moe`` for prompt hints (``auto`` infers from the model id)."""
    h = (getattr(connection, 'architecture_hint', None) or 'auto').strip().lower()
    if h == 'moe':
        return 'moe'
    if h == 'dense':
        return 'dense'
    m = (connection.model or '').lower()
    if 'a4b' in m or ('26b' in m and 'moe' in m):
        return 'moe'
    return 'dense'


def effective_parallel_tool_calls(connection: RuntimeConnection) -> bool:
    """Parallel tool calls: disabled under Qwen optimize profile (more stable on many OpenAI-compatible stacks)."""
    if qwen_optimize_profile_active(connection):
        return False
    return bool(connection.parallel_tool_calls)


GEMMA_RECOMMENDED_TOP_P = 0.95
GEMMA_RECOMMENDED_TOP_K = 64


def gemma_sampling_kwargs_for_llm(connection: RuntimeConnection) -> dict[str, Any]:
    """Extra ``ChatOpenAI`` kwargs for Gemma sampling.

    ``top_p`` is a standard Chat Completions field. ``top_k`` is not accepted by the
    OpenAI Python client's ``create()`` signature when merged from ``model_kwargs``;
    LM Studio and other OpenAI-compatible stacks expect it under ``extra_body`` instead
    (see LangChain ``ChatOpenAI`` docs: model_kwargs vs extra_body).
    """
    if optimization_preset(connection) != 'gemma':
        return {}
    preset = (getattr(connection, 'sampling_preset', None) or 'provider-default').strip().lower()
    out: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    if preset == 'gemma-recommended':
        out['top_p'] = GEMMA_RECOMMENDED_TOP_P
        extra['top_k'] = GEMMA_RECOMMENDED_TOP_K
    elif preset == 'custom':
        tp = getattr(connection, 'top_p', None)
        tk = getattr(connection, 'top_k', None)
        if tp is not None:
            out['top_p'] = float(tp)
        if tk is not None:
            extra['top_k'] = int(tk)
    if extra:
        out['extra_body'] = extra
    return out


def llm_optional_kwargs(connection: RuntimeConnection) -> dict[str, Any]:
    """Extra ``ChatOpenAI`` kwargs (e.g. ``max_tokens``) derived from env, connection, then preset profiles."""
    out: dict[str, Any] = {}
    global_max = os.getenv('NEMO_CHAT_MAX_OUTPUT_TOKENS', '').strip()
    if global_max.isdigit():
        v = int(global_max)
        if v > 0:
            out['max_tokens'] = v
        return out
    conn_max = int(getattr(connection, 'max_output_tokens', 0) or 0)
    if conn_max > 0:
        out['max_tokens'] = conn_max
        return out
    if qwen_optimize_profile_active(connection):
        raw = os.getenv('NEMO_QWEN_DEFAULT_MAX_OUTPUT_TOKENS', '8192').strip() or '8192'
        try:
            default_max = int(raw)
        except ValueError:
            default_max = 8192
        if default_max > 0:
            out['max_tokens'] = default_max
        return out
    if gemma_optimize_profile_active(connection):
        raw = os.getenv('NEMO_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS', '16384').strip() or '16384'
        try:
            default_max = int(raw)
        except ValueError:
            default_max = 16384
        if default_max > 0:
            out['max_tokens'] = default_max
        return out
    return out


def tool_calling_and_edit_semantics_suffix() -> str:
    """Tool channel and direct workspace edit semantics; appended for every model."""
    return (
        '\n\nModel note (tools): Never put tool arguments or <tool_call> XML in plain assistant text—'
        'only use the API tool channel.\n'
        'Direct workspace edit tools (non-code paths only\u2014e.g. .md, .json, .yaml; not .py/.ts/.js and other '
        'code-review extensions): To create a new file or rewrite an entire file, use `apply_workspace_full_file` '
        'with `new_content` (the complete file text). For source code, use `execute_workspace_mutation` or '
        '`plan_and_modify` instead. '
        '`replace_workspace_snippet` is ONLY for editing existing non-code files and requires a non-empty `old_snippet` '
        'that matches text already present in the file; never pass an empty string for `old_snippet`. For localized '
        'edits, prefer `replace_workspace_line_range` with `start_line` and `end_line` (1-based inclusive).\n'
        'Paths: Prefer a single write with the full relative path including any new nested directories; parent '
        'directories are created automatically on write. Do not create empty directory trees unless the user asked '
        'for empty folders.\n'
    )


def parallel_batching_prompt_suffix() -> str:
    """When parallel tool calls are enabled, encourage batching independent reads in one completion."""
    return (
        '\nModel note (parallel tools): When the API allows multiple tool calls in one completion, you may batch '
        'independent read, search, or LSP inspection calls together in a single turn.\n'
    )


def qwen_specific_prompt_suffix() -> str:
    """Qwen-family stability hint (single tool per turn); use with :func:`tool_calling_and_edit_semantics_suffix`."""
    return (
        '\nModel note (Qwen): Prefer one tool call per assistant turn when you can; wait for the tool result '
        'before issuing the next call.\n'
    )


def gemma_thinking_prompt_suffix(connection: RuntimeConnection) -> str:
    """Gemma thinking / MoE hints when Gemma optimize profile is active."""
    if not gemma_optimize_profile_active(connection):
        return ''
    mode = (getattr(connection, 'thinking_mode', None) or 'default').strip().lower()
    parts: list[str] = []
    if mode == 'on':
        parts.append(
            '\nModel note (Gemma thinking): Use structured reasoning for harder tasks when helpful. '
            'The local server chat template may inject thinking tokens (e.g. <|think|>) when thinking is enabled.\n'
        )
    elif mode == 'off':
        parts.append(
            '\nModel note (Gemma thinking): Prefer direct answers; avoid long scratchpad-style reasoning '
            'unless the user explicitly asks for step-by-step work.\n'
        )
    if effective_architecture_hint(connection) == 'moe':
        parts.append(
            '\nModel note (Gemma MoE): Sparse mixture-of-experts variant (many total parameters, few active per '
            'token); keep each assistant turn focused.\n'
        )
    return ''.join(parts)


def qwen_system_prompt_suffix() -> str:
    """Backward-compatible name: full Qwen block equals universal semantics plus Qwen-only lines."""
    return tool_calling_and_edit_semantics_suffix() + qwen_specific_prompt_suffix()


def combined_model_prompt_suffix(connection: RuntimeConnection) -> str:
    """Universal tool/edit semantics, optional parallel batching, optional Qwen single-call hint, optional Gemma."""
    parts = [tool_calling_and_edit_semantics_suffix()]
    if effective_parallel_tool_calls(connection):
        parts.append(parallel_batching_prompt_suffix())
    if qwen_optimize_profile_active(connection):
        parts.append(qwen_specific_prompt_suffix())
    parts.append(gemma_thinking_prompt_suffix(connection))
    return ''.join(parts)
