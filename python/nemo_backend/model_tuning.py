"""Heuristic tuning for specific model families and optimization presets (Qwen, Capable API, etc.).

The desktop **Optimization template** (``optimization_preset`` on the active connection) can force
the Qwen profile even when the model id does not contain ``qwen``. For **generic**, enable auto
heuristics with ``NEMO_QWEN_OPTIMIZE`` (default on) when the model id looks like Qwen.
The **capable** preset turns on parallel tool calls by default (UI) and appends batching hints in the system prompt.

``max_output_tokens`` on the connection sets API ``max_tokens`` when positive; otherwise preset/env
defaults apply. Global env ``NEMO_CHAT_MAX_OUTPUT_TOKENS`` still wins for all models.
"""

from __future__ import annotations

import os
from typing import Any

from nemo_backend.domain import RuntimeConnection


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, '').strip().lower()
    if not raw:
        return default
    return raw in ('1', 'true', 'yes', 'on')


def is_qwen_family(model: str) -> bool:
    """True when the configured model id is likely Qwen (local or API)."""
    return 'qwen' in (model or '').lower()


def optimization_preset(connection: RuntimeConnection) -> str:
    return (getattr(connection, 'optimization_preset', None) or 'generic').strip().lower()


def qwen_optimize_profile_active(connection: RuntimeConnection) -> bool:
    """True when the Qwen template is selected or generic + model id looks like Qwen (env-gated)."""
    if optimization_preset(connection) == 'qwen':
        return True
    return is_qwen_family(connection.model) and _env_bool('NEMO_QWEN_OPTIMIZE', True)


def effective_parallel_tool_calls(connection: RuntimeConnection) -> bool:
    """Parallel tool calls: disabled under Qwen optimize profile (more stable on many OpenAI-compatible stacks)."""
    if qwen_optimize_profile_active(connection):
        return False
    return bool(connection.parallel_tool_calls)


def llm_optional_kwargs(connection: RuntimeConnection) -> dict[str, Any]:
    """Extra ``ChatOpenAI`` kwargs (e.g. ``max_tokens``) derived from env, connection, then Qwen profile."""
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
    if not qwen_optimize_profile_active(connection):
        return out
    raw = os.getenv('NEMO_QWEN_DEFAULT_MAX_OUTPUT_TOKENS', '8192').strip() or '8192'
    try:
        default_max = int(raw)
    except ValueError:
        default_max = 8192
    if default_max > 0:
        out['max_tokens'] = default_max
    return out


def tool_calling_and_edit_semantics_suffix() -> str:
    """Tool channel and direct workspace edit semantics; appended for every model."""
    return (
        '\n\nModel note (tools): Never put tool arguments or <tool_call> XML in plain assistant text—'
        'only use the API tool channel.\n'
        'Direct workspace edit tools: To create a new file or rewrite an entire file, use `apply_workspace_full_file` '
        'with `new_content` (the complete file text). `replace_workspace_snippet` is ONLY for editing existing files '
        'and requires a non-empty `old_snippet` that matches text already present in the file; never pass an '
        'empty string for `old_snippet`. For localized edits, prefer `replace_workspace_line_range` with '
        '`start_line` and `end_line` (1-based inclusive).\n'
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


def qwen_system_prompt_suffix() -> str:
    """Backward-compatible name: full Qwen block equals universal semantics plus Qwen-only lines."""
    return tool_calling_and_edit_semantics_suffix() + qwen_specific_prompt_suffix()


def combined_model_prompt_suffix(connection: RuntimeConnection) -> str:
    """Universal tool/edit semantics, optional parallel batching, optional Qwen single-call hint."""
    parts = [tool_calling_and_edit_semantics_suffix()]
    if effective_parallel_tool_calls(connection):
        parts.append(parallel_batching_prompt_suffix())
    if qwen_optimize_profile_active(connection):
        parts.append(qwen_specific_prompt_suffix())
    return ''.join(parts)
