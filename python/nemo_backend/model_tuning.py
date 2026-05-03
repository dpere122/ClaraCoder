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
from nemo_backend.state import runtime_config


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


def sparse_expert_variant_for_prompts(connection: RuntimeConnection) -> bool:
    """True when Gemma-style sparse-expert layout notes should apply (model id only; not a separate agent graph)."""
    h = (getattr(connection, 'architecture_hint', None) or 'auto').strip().lower()
    if h == 'dense':
        return False
    m = (connection.model or '').lower()
    return 'a4b' in m or ('26b' in m and 'moe' in m)


def effective_parallel_tool_calls(connection: RuntimeConnection) -> bool:
    """Parallel tool calls: disabled under Qwen optimize profile (more stable on many OpenAI-compatible stacks)."""
    if qwen_optimize_profile_active(connection):
        return False
    return bool(connection.parallel_tool_calls)


GEMMA_RECOMMENDED_TOP_P = 0.95
GEMMA_RECOMMENDED_TOP_K = 64


def connection_user_sampling_kwargs_for_llm(connection: RuntimeConnection) -> dict[str, Any]:
    """Map explicit Settings sampling fields to ``ChatOpenAI`` kwargs / ``extra_body``.

    ``top_p`` / ``top_k`` from the connection are skipped when the Gemma template already
    derives them from :func:`gemma_sampling_kwargs_for_llm` (recommended or custom preset).
    ``min_p`` and ``repeat_penalty`` are sent in ``extra_body`` for OpenAI-compatible locals
    (e.g. llama.cpp ``llama-server``); ``presence_penalty`` uses the standard Chat Completions field.
    """
    out: dict[str, Any] = {}
    extra: dict[str, Any] = {}

    opt = optimization_preset(connection)
    sp = (getattr(connection, 'sampling_preset', None) or 'provider-default').strip().lower()
    gemma_owns_top = opt == 'gemma' and sp in ('gemma-recommended', 'custom')

    if not gemma_owns_top:
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


def tool_calling_and_edit_semantics_suffix(_connection: RuntimeConnection | None = None) -> str:
    """Tool channel and staged workspace edit semantics; appended for every model."""
    nested_note = (
        'Nested delegation (`plan_and_modify`, `execute_workspace_mutation`) is not available—use staging (`stage_*`) '
        'and `transfer_staged_file_to_workspace` for source and structured-config paths. '
    )
    return (
        '\n\nModel note (tools): Never put tool arguments or <tool_call> XML in plain assistant text—'
        'only use the API tool channel.\n'
        '**Workspace edits:** Treat the on-disk workspace as the checkpoint. For **every** text path, create or revise '
        'content with `stage_create_file`, `stage_workspace_file_overwrite`, `stage_line_range_edit`, or `stage_snippet_edit` '
        '(when bound), inspect drafts with `list_staged_edits` / `diff_staged_edit_against_baseline` / `read_staged_edit`, '
        'then call `transfer_staged_file_to_workspace` when correct. Never ask the user to apply or approve that '
        'transfer for you—only the tool call counts. Do not use legacy direct-to-disk workspace mutators '
        '(`apply_workspace_full_file`, `replace_workspace_*`) on agent graphs—they are not the primary path. '
        + nested_note
        + '**LSP file mutations vs staging:** For `.py`, prefer `lsp_create_python_file` / `lsp_update_python_file` / '
        '`lsp_delete_python_file` when those tools appear in **your** bound tool list (outer Clara with Editor on). '
        'If they are not on your graph, use `stage_*` for Python. '
        + 'For localized edits on existing files, prefer `stage_line_range_edit` or `stage_snippet_edit` over whole-file '
        'rewrites when practical. Paths: use the full relative path; parent directories are created when the transfer lands.\n'
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
        'before issuing the next call. When staging review applies, call `transfer_staged_file_to_workspace` '
        'yourself—do not ask the user to approve or apply the diff in the UI instead of using the tool.\n'
    )


def gemma_thinking_prompt_suffix(connection: RuntimeConnection) -> str:
    """Gemma thinking and sparse-expert layout hints when Gemma optimize profile is active."""
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
    if sparse_expert_variant_for_prompts(connection):
        parts.append(
            '\nModel note (Gemma sparse experts): Sparse mixture-of-experts layout (many total parameters, few active '
            'per token); keep each assistant turn focused.\n'
        )
    parts.append(
        '\nModel note (Gemma visible text): Do not paste Gemma chat-template control markers (e.g. `<|channel|>`, '
        '`<|channel>`, other `<|...>` tags) or raw `<turn|>` into the user-facing answer. Put scratchpad / '
        'step-by-step reasoning in the reasoning channel when the server supports it—not in the main reply. '
        'Keep tools on the API tool channel only.\n'
    )
    return ''.join(parts)


def gemma_sparse_expert_workspace_suffix(connection: RuntimeConnection) -> str:
    """Gemma preset + sparse-expert model id: staging vs disk and small-step edit discipline."""
    if not gemma_optimize_profile_active(connection):
        return ''
    if not sparse_expert_variant_for_prompts(connection):
        return ''
    return (
        '\nModel note (Gemma sparse experts — workspace edits):\n'
        '- **Single-purpose mutations:** Do not bundle refactoring, new features, and bug fixes into one huge step '
        'for the same file. Prefer a **linear sequence** of small staging calls; do not assume parallel '
        'writes to the same path are safe.\n'
        '- **Checkpoint between edits:** After **staging** code, the draft is not on disk yet—refresh anchors from '
        '`read_staged_edit` or `diff_staged_edit_against_baseline`, not `read_workspace_file` (that still shows the '
        'pre-transfer baseline). After **`transfer_staged_file_to_workspace`**, treat the workspace file as source of '
        'truth and use `read_workspace_file` or LSP with `refresh_active_document=true` before the next mutation.\n'
        '- **Atomic patches, stable anchors:** Prefer `stage_snippet_edit` with **unique surrounding context** over '
        'stacking dependent line-range replacements without re-reading staged or workspace text.\n'
        '- **Review synthesis:** When code review rejects staged work, deconstruct each issue, locate the exact '
        'region, apply minimal surgical fixes, then re-check diagnostics on touched paths.\n'
    )


def qwen_system_prompt_suffix(connection: RuntimeConnection | None = None) -> str:
    """Backward-compatible name: full Qwen block equals universal semantics plus Qwen-only lines."""
    return tool_calling_and_edit_semantics_suffix(connection) + qwen_specific_prompt_suffix()


def combined_model_prompt_suffix(connection: RuntimeConnection) -> str:
    """Universal tool/edit semantics, optional parallel batching, optional Qwen single-call hint, optional Gemma."""
    parts = [tool_calling_and_edit_semantics_suffix(connection)]
    if effective_parallel_tool_calls(connection):
        parts.append(parallel_batching_prompt_suffix())
    if qwen_optimize_profile_active(connection):
        parts.append(qwen_specific_prompt_suffix())
    parts.append(gemma_thinking_prompt_suffix(connection))
    parts.append(gemma_sparse_expert_workspace_suffix(connection))
    return ''.join(parts)
