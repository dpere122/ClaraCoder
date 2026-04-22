"""LangChain message conversion, assistant text extraction, and system prompt.

Turns stored session history dicts into :class:`~langchain_core.messages.BaseMessage`
instances and builds the long system prompt (workspace + host + connection hints).
"""

from __future__ import annotations

import re
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from nemo_backend.domain import SessionState
from nemo_backend.llm_visible_text import is_placeholder_thinking_noise
from nemo_backend.model_tuning import combined_model_prompt_suffix
from nemo_backend.prompt_blocks import python_workspace_playbook, routing_handoff_contract
from nemo_backend.state import get_active_connection, runtime_config

# Precompiled patterns for detecting "pseudo" tool syntax in plain model text.
_RE_PSEUDO_FUNCTION_TAG = re.compile(r'<\s*function\s*=', re.IGNORECASE)
_RE_PSEUDO_PARAMETER_TAG = re.compile(r'<\s*parameter\s*=', re.IGNORECASE)


def session_to_messages(session: SessionState) -> list[BaseMessage]:
    """Map session.history entries to LangChain message objects for the LLM."""
    result: list[BaseMessage] = []
    for item in session.history:
        role = item.get('role', 'user')
        content: Any = item.get('content', '')
        if role == 'assistant':
            result.append(AIMessage(content=content))
        elif role == 'system':
            result.append(SystemMessage(content=content))
        else:
            result.append(HumanMessage(content=content))
    return result


def outer_turn_authority_preamble(session: SessionState, apply_mode: bool) -> str:
    """Compact live-settings block prepended to each outer Clara turn so the model attends to current truth."""
    orch = runtime_config.tools.orchestrated_mode
    orch_s = 'on' if orch else 'off'
    editor_s = 'on' if apply_mode else 'off'
    auto_s = 'on' if session.auto_apply_mode else 'off'
    overlap = session.active_editor_langgraph_streams > 0
    overlap_line = (
        '\n- Other concurrent Editor streams in this session: **yes** (another turn may still be writing).'
        if overlap
        else ''
    )
    return (
        '**Session truth (authoritative for this message; older assistant replies may be outdated):**\n'
        f'- Editor (toolbar, this turn): **{editor_s}**\n'
        f'- Orchestrated mode (backend): **{orch_s}**\n'
        f'- Auto-apply (UI): **{auto_s}**'
        f'{overlap_line}\n'
        '- If any line above conflicts with earlier assistant prose in this chat, trust **this block** and the **current** '
        'system instructions—not stale narration.\n'
    )


def compose_outer_turn_human_content(
    session: SessionState,
    apply_mode: bool,
    user_message: str | list[dict[str, Any]],
) -> str | list[dict[str, Any]]:
    """Prepend :func:`outer_turn_authority_preamble` to the outer agent user turn (string or multimodal list)."""
    preamble = outer_turn_authority_preamble(session, apply_mode)
    if isinstance(user_message, str):
        return f'{preamble}\n{user_message}'
    merged: list[dict[str, Any]] = list(user_message)
    if not merged:
        return [{'type': 'text', 'text': preamble}]
    first = merged[0]
    if isinstance(first, dict) and str(first.get('type') or '').lower() == 'text':
        base = str(first.get('text') or '')
        merged[0] = {**first, 'text': f'{preamble}\n{base}'}
        return merged
    merged.insert(0, {'type': 'text', 'text': f'{preamble}\n'})
    return merged


def stringify_content(content: Any) -> str:
    """Normalize multimodal or structured message content to a single string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get('text') or item.get('content')
                if text:
                    parts.append(str(text))
                    continue
                kind = str(item.get('type') or '').strip()
                if kind:
                    parts.append(f'[{kind}]')
                continue
            text = getattr(item, 'text', None)
            if text:
                parts.append(str(text))
        return ''.join(parts)
    return str(content or '')


def _reasoning_body(message: AIMessage) -> str:
    """Extract provider reasoning / thinking text from AIMessage (multiple possible shapes)."""
    r = getattr(message, 'reasoning', None)
    if isinstance(r, str) and r.strip():
        out = r.strip()
        return '' if is_placeholder_thinking_noise(out) else out
    ak = getattr(message, 'additional_kwargs', None) or {}
    for key in ('reasoning_content', 'reasoning'):
        val = ak.get(key)
        if isinstance(val, str) and val.strip():
            out = val.strip()
            return '' if is_placeholder_thinking_noise(out) else out
        if isinstance(val, dict):
            for sub in ('summary', 'text', 'content'):
                s = val.get(sub)
                if isinstance(s, str) and s.strip():
                    out = s.strip()
                    return '' if is_placeholder_thinking_noise(out) else out
    return ''


def assistant_visible_answer(message: AIMessage) -> str:
    """User-visible assistant text from normal content only (no reasoning-channel fallback)."""
    via_lc = str(getattr(message, 'text', None) or '').strip()
    raw = via_lc if via_lc else stringify_content(message.content).strip()
    if raw and is_placeholder_thinking_noise(raw):
        return ''
    return raw


def final_assistant_text(message: AIMessage) -> str:
    """Text the agent loop treats as the model's answer (content, or reasoning if content empty)."""
    vis = assistant_visible_answer(message)
    if vis:
        return vis
    return _reasoning_body(message)


def reasoning_sidecar_text(message: AIMessage) -> str:
    """Reasoning to show separately when the model also returned a visible main answer."""
    body = _reasoning_body(message)
    if not body:
        return ''
    vis = assistant_visible_answer(message)
    if not vis:
        return ''
    if body.strip() == vis.strip():
        return ''
    return body


def text_uses_pseudo_tool_markup(text: str) -> bool:
    """True when the model wrote tool usage as prose/XML but sent no structured tool_calls."""
    if not text or not text.strip():
        return False
    if '<tool_call' in text and '</tool_call>' in text:
        return True
    if _RE_PSEUDO_FUNCTION_TAG.search(text):
        return True
    if _RE_PSEUDO_PARAMETER_TAG.search(text):
        return True
    return False


_STAGING_TREE_SECTION_MARKER = '\n\nNested edit staging tree ('


def _workspace_context_without_staging(workspace_context: str) -> str:
    """Strip the appended staging-tree section from a combined workspace/staging snapshot."""
    if not workspace_context:
        return ''
    before, marker, _after = workspace_context.partition(_STAGING_TREE_SECTION_MARKER)
    if not marker:
        return workspace_context
    return before.rstrip()


def _workspace_hint(session: SessionState, *, include_staging: bool = False) -> str:
    if not session.workspace_path:
        return 'No workspace is attached to this conversation.'
    workspace_context = session.workspace_context or ''
    if not include_staging:
        workspace_context = _workspace_context_without_staging(workspace_context)
    label = 'Workspace context snapshot' if include_staging else 'Workspace tree snapshot'
    return (
        f'Workspace path: {session.workspace_path}\n\n'
        f'{label}:\n{workspace_context or "[empty]"}'
    )


def _connection_line(session: SessionState) -> str:
    connection = get_active_connection()
    return (
        f'Active model connection: {connection.name} ({connection.provider}, model={connection.model}).'
    )


def _model_prompt_suffix() -> str:
    """Universal tool/edit semantics plus optional parallel-batching and Qwen-specific lines."""
    return combined_model_prompt_suffix(get_active_connection())


def _os_hint_line() -> str:
    host = runtime_config.host
    if not host.platform:
        return 'Host operating system: unavailable.'
    return (
        f'Host operating system: {host.label or host.platform} '
        f'(platform={host.platform}, release={host.release or "unknown"}, '
        f'version={host.version or "unknown"}, arch={host.arch or "unknown"}).'
    )


def _outer_agent_operational_block(apply_mode: bool) -> str:
    """Outer Clara: reads/search; direct copy; nested mutation tools for source code when Editor is on."""
    base = (
        'Operational guidance:\n'
        '- For codebase questions, inspect the workspace before making claims.\n'
        '- After checking the workspace tree, resolve uncertainty with tools rather than long speculation; if blocked, '
        'state the single missing fact and the next tool you would call.\n'
        '- If a tool returns partial data, say what is missing.\n'
        '- When your answer refers to code or files, name the relevant paths clearly.\n'
        '- Match shell guidance to the detected host OS; do not assume Bash is available on Windows.\n'
        '- If no workspace is loaded, say that no local files were available.\n'
        '- Read-only inspection: start with the workspace tree in your system instructions above for structure and likely file paths. '
        'Use `list_workspace_directory` only when that tree is insufficient, stale, or you need to confirm a specific subtree. '
        'Prefer `retrieve_workspace_semantic` first for broad topical recall (**workspace checkpoint + nested staging**), then '
        '`search_workspace`, `read_workspace_file`, and `list_workspace_directory` as needed—treat semantic hits as hints. '
        'Each hit lists **origin**: use `read_workspace_file` / LSP / `search_workspace` to confirm **workspace** chunks; '
        'use `read_staged_edit` or `diff_staged_edit_against_baseline` for **staging** chunks (`read_workspace_file` is the '
        'on-disk checkpoint until `transfer_staged_file_to_workspace`). For Python and '
        'TypeScript/JavaScript source (`.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`), prefer the LSP-directed tools '
        '(`lsp_get_diagnostics`, `lsp_get_document_symbols`, `lsp_hover`, '
        '`lsp_find_definition`, `lsp_find_references`) over ordinary file reads whenever they provide the needed context. '
        'For `.pdf` files, `read_workspace_file` treats start_line/end_line as 1-based page numbers (extracted text per page).\n'
        '- Text encoding/newlines: `read_workspace_file` / `search_workspace` accept `encoding`; nested edit tools accept `encoding` '
        'and `newline` (lf, crlf, preserve). Defaults come from app Settings → Tools.\n'
    )
    if not apply_mode:
        return (
            base
            + '- **Backend (authoritative):** Editor mode is **OFF** for this turn; workspace mutation and staging '
            'tools are not bound. Ignore any stale prior assistant text that claims Editor is on or lists write tools.\n'
            '- Editor mode is off: workspace write tools are not available\u2014use read-only tools only. '
            'If the user wants patches or deletes from chat, ask them to enable Editor in the toolbar.\n'
        )
    orchestrated = runtime_config.tools.orchestrated_mode
    if not orchestrated:
        return (
            base
            + '- **Backend (authoritative):** Orchestrated mode is **OFF** in this Python process (`POST /runtime-config`); '
            '`plan_and_modify` / `execute_workspace_mutation` are not bound. Do not claim orchestration is on, and ignore any '
            'stale prior assistant text that disagrees.\n'
            + '- Editor mode is on (**Orchestrated mode off** in Settings → Tools): you have read/search tools, '
            '`copy_workspace_files`, `delete_workspace_entry` and `batch_delete_workspace_entries`, **staged** '
            'create/update tools (`stage_create_file`, `stage_workspace_file_overwrite`, `stage_line_range_edit`, '
            'and `stage_snippet_edit` when bound), review/transfer tools, dependency installs, workspace tests, and '
            'staging-focused specialist tools (`code_review_specialist_*`, etc.). Nested delegation '
            '(`execute_workspace_mutation`, `plan_and_modify`) is **not** bound\u2014use the staging pipeline for '
            '**all** programming-path and structured-config edits.\n'
            '- **Workspace checkpoint:** `read_workspace_file` shows the **on-disk workspace**. Pending edits live in '
            '**staging** until `transfer_staged_file_to_workspace` succeeds\u2014use `list_staged_edits`, '
            '`diff_staged_edit_against_baseline`, and `read_staged_edit` to inspect drafts.\n'
            '- **Source code and structured config** (`.py`, `.ts`, `.json`, `.yaml`, …): stage changes, run review/diagnostics '
            'on drafts, then **`transfer_staged_file_to_workspace`**\u2014same as other text files.\n'
            '- **All other text files** (e.g. .md, .txt): same staging tools and **`transfer_staged_file_to_workspace`** '
            'after review.\n'
            '- **Python dependencies** and **Node/npm** tools are available when you need them without nested routing.\n'
            '- **Workspace verification:** you may call `run_workspace_pytest_tests` or `run_workspace_python_smoke_test` '
            'for Python checks.\n'
            '- Use `copy_workspace_files` only when you need to duplicate existing workspace files to new paths.\n'
            '- Read and inspect relevant files before editing. Prefer **small, verifiable** staging steps; refresh anchors '
            'from `read_staged_edit` or diff tools between dependent edits.\n'
            '- **After** transferring touched **Python or TS/JS** paths, call `lsp_get_diagnostics` '
            '(use `refresh_active_document=true` to re-read the on-disk file in workspace scope) before claiming the change is clean.\n'
            '- The user may review diffs or confirm copy/delete actions in the UI unless auto-apply is enabled.\n'
            '- Summarize outcomes clearly (paths touched, what changed). Do not paste raw tool dumps.\n'
        )
    return (
        base
        + '- **Backend (authoritative):** Orchestrated mode is **ON** in this Python process; `plan_and_modify` and '
        '`execute_workspace_mutation` are bound when Editor mode is on. Do not claim they are missing, and ignore any stale '
        'prior assistant text that disagrees.\n'
        + '- Editor mode is on: you have read/search tools, `copy_workspace_files`, `delete_workspace_entry` and '
        '`batch_delete_workspace_entries` (any workspace path; non-empty dirs need `recursive=true`; the UI may ask '
        'for confirmation when auto-apply is off), **staged** create/update tools (`stage_create_file`, '
        '`stage_workspace_file_overwrite`, `stage_line_range_edit`, and `stage_snippet_edit` when bound) plus review/transfer '
        'tools, and nested delegation: `execute_workspace_mutation` (single focused step, router + specialists only) and '
        '`plan_and_modify` (planner when enabled: discovery, multi-step plan, final project review).\n'
        '- **Workspace checkpoint:** `read_workspace_file` shows the **on-disk workspace**. Pending edits live in **staging** '
        'until `transfer_staged_file_to_workspace` succeeds—use `list_staged_edits`, `diff_staged_edit_against_baseline`, '
        'and `read_staged_edit` to inspect drafts.\n'
        '- **Source code and structured config** (code-review extensions such as .py, .ts, .js, .json, .yaml, .xml, .toml, '
        '.go, .rs, etc.): prefer `execute_workspace_mutation` or `plan_and_modify` so the nested router runs discover, '
        'stage, and code review before the workspace updates. If you edit those paths yourself on this graph, use the '
        'same staging tools then **`transfer_staged_file_to_workspace`**—do not use legacy direct-to-disk workspace mutators.\n'
        '- **All other text files** (e.g. .md, .txt): use the same staging tools and **`transfer_staged_file_to_workspace`** '
        'after review; the workspace on disk stays the checkpoint until transfer.\n'
        '- **Python dependencies** (`install_python_packages`, `remove_python_packages`, requirements/freeze tools, etc.), '
        '**Node/npm** (`install_npm_packages`, `npm_install_project`, `run_npm_script`, …), '
        'and **staging review** (`list_staged_edits`, `diff_staged_edit_against_baseline`, `transfer_staged_file_to_workspace`, '
        '`reject_staged_workspace_edit`, …) are available on this agent when you need them without delegating through '
        '`execute_workspace_mutation` / `plan_and_modify`.\n'
        '- **Workspace verification:** you may call `run_workspace_pytest_tests` or `run_workspace_python_smoke_test` '
        'directly for quick Python checks before or after nested work. Pass/fail gating for planner-driven tasks still '
        'belongs to `plan_and_modify` and the nested `run_final_project_review` flow—not to ad-hoc outer verification alone.\n'
        '- Use `copy_workspace_files` only when you need to duplicate existing workspace files to new paths.\n'
        'Read and inspect relevant files first. For `execute_workspace_mutation` and `plan_and_modify`, use a clear '
        '`task_summary`: after discovery, put the **Routing handoff** block first (same contract as nested and '
        'orchestrator-composed step instructions), then goal, constraints, acceptance hints, and the **minimum** context (paths, symbols, '
        'short excerpts) so the nested router and specialists do not repeat your reads. For code steps, nested review '
        'compares workspace baseline vs staged draft with a mechanical diff tool before approval; list every code path '
        'the step must touch so each can be transferred after review.\n'
        f'{routing_handoff_contract()}\n'
        '- **Inspect–integrate–mutate–verify (nested source work):** Before delegating, base **Existence** on tools, not '
        'only the user message—for **update** (or when a path might already exist), use `read_workspace_file` and/or LSP '
        'reads on those paths first so you augment or replace real content, not a guess. When adding I/O, config, '
        'logging, or helpers, use `search_workspace` to find existing patterns and reuse them when they fit.\n'
        '- **After** `execute_workspace_mutation` or `plan_and_modify` returns, for each touched **Python or TS/JS** path you '
        'care about, call `lsp_get_diagnostics` (use `refresh_active_document=true` to re-read the on-disk file in workspace scope) '
        'before telling the user the change is clean; mention any remaining diagnostics in your summary.\n'
        '- **Incremental mutations:** Prefer `execute_workspace_mutation` (or several calls) for a **single verifiable** '
        'slice; use `plan_and_modify` when you need multi-step discovery, a checklist, or final project review across '
        'multiple build actions.\n'
        '- The user may review diffs or confirm copy/delete actions in the UI unless auto-apply is enabled.\n'
        '- After `execute_workspace_mutation` or `plan_and_modify` returns, answer the user with a concise summary of '
        'outcomes (files touched, key edits or findings). Do not paste raw nested output or token-by-token detail.\n'
        '- If the tool result ends with **Notes for Clara**, treat that block as authoritative handoffs from the '
        'planner and review specialists (checklist, code review outcomes, final review). Fold them into your reply '
        'to the user in plain language.\n'
    )


def build_system_prompt(session: SessionState, apply_mode: bool) -> str:
    """Assemble Clara's system prompt: role, tools policy, connection, OS, workspace."""
    workspace_hint = _workspace_hint(session)
    return (
        'You are Clara, a proactive coding assistant inside an Electron desktop app. '
        'Use the available tools whenever a request depends on inspecting or searching the workspace. '
        'Prefer quoting exact file paths, line numbers, commands, and concrete next steps. '
        'Keep answers concise but useful, and explain what you actually inspected.\n\n'
        f'{_connection_line(session)}\n\n'
        f'{_os_hint_line()}\n\n'
        f'{_outer_agent_operational_block(apply_mode)}'
        f'{workspace_hint}'
        f'{_model_prompt_suffix()}'
    )
