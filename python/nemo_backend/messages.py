"""LangChain message conversion, assistant text extraction, and system prompt.

Turns stored session history dicts into :class:`~langchain_core.messages.BaseMessage`
instances and builds the long system prompt (workspace + host + connection hints).
"""

from __future__ import annotations

import re
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from nemo_backend.domain import SessionState
from nemo_backend.model_tuning import combined_model_prompt_suffix
from nemo_backend.prompt_blocks import routing_handoff_contract
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
        return r.strip()
    ak = getattr(message, 'additional_kwargs', None) or {}
    for key in ('reasoning_content', 'reasoning'):
        val = ak.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, dict):
            for sub in ('summary', 'text', 'content'):
                s = val.get(sub)
                if isinstance(s, str) and s.strip():
                    return s.strip()
    return ''


def assistant_visible_answer(message: AIMessage) -> str:
    """User-visible assistant text from normal content only (no reasoning-channel fallback)."""
    via_lc = str(getattr(message, 'text', None) or '').strip()
    if via_lc:
        return via_lc
    return stringify_content(message.content).strip()


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
        'Use `list_workspace_directory` only when that tree is insufficient, stale, or you need to confirm a specific subtree. Then use '
        '`list_workspace_directory`, `read_workspace_file`, and `search_workspace` to inspect files. For Python source, '
        'prefer the LSP-directed tools (`lsp_get_diagnostics`, `lsp_get_document_symbols`, `lsp_hover`, '
        '`lsp_find_definition`, `lsp_find_references`) over ordinary file reads whenever they provide the needed context. '
        'For `.pdf` files, `read_workspace_file` treats start_line/end_line as 1-based page numbers (extracted text per page).\n'
        '- Text encoding/newlines: `read_workspace_file` / `search_workspace` accept `encoding`; nested edit tools accept `encoding` '
        'and `newline` (lf, crlf, preserve). Defaults come from app Settings → Tools.\n'
    )
    if not apply_mode:
        return (
            base
            + '- Editor mode is off: workspace write tools are not available\u2014use read-only tools only. '
            'If the user wants patches or deletes from chat, ask them to enable Editor in the toolbar.\n'
        )
    return (
        base
        + '- Editor mode is on: you have read/search tools, `copy_workspace_files`, `delete_workspace_entry` and '
        '`batch_delete_workspace_entries` (any workspace path; non-empty dirs need `recursive=true`; the UI may ask '
        'for confirmation when auto-apply is off), direct workspace edit tools for **non-code** paths, and nested tools '
        'for **source code**: `execute_workspace_mutation` (single focused step, router + specialists only) and '
        '`plan_and_modify` (planner when enabled: discovery, multi-step plan, final project review).\n'
        '- **Source code** (code-review extensions such as .py, .ts, .js, .tsx, .go, .rs, etc.): use '
        '`execute_workspace_mutation` or `plan_and_modify`—never direct edit tools—so work goes through nested staging '
        'and code review. Those tools always reach the same **file-write specialist** subgraph the planner uses '
        '(discover, stage, then code review before the workspace updates). Do not paste full source files into chat as a '
        'substitute for running that pipeline.\n'
        '- **Non-code** (e.g. .md, .json, .yaml, .txt): use `apply_workspace_full_file`, `replace_workspace_line_range`, '
        'or `replace_workspace_snippet` for CRUD-style edits; they open diffs or auto-apply per settings.\n'
        '- Use `copy_workspace_files` only when you need to duplicate existing workspace files to new paths.\n'
        'Read and inspect relevant files first. For `execute_workspace_mutation` and `plan_and_modify`, use a clear '
        '`task_summary`: after discovery, put the **Routing handoff** block first (same contract the coding planner uses '
        'for `execute_plan_step`), then goal, constraints, acceptance hints, and the **minimum** context (paths, symbols, '
        'short excerpts) so the nested router and specialists do not repeat your reads. For code steps, nested review '
        'compares workspace baseline vs staged draft with a mechanical diff tool before approval; list every code path '
        'the step must touch so each can be transferred after review.\n'
        f'{routing_handoff_contract()}\n'
        '- **Inspect–integrate–mutate–verify (nested source work):** Before delegating, base **Existence** on tools, not '
        'only the user message—for **update** (or when a path might already exist), use `read_workspace_file` and/or LSP '
        'reads on those paths first so you augment or replace real content, not a guess. When adding I/O, config, '
        'logging, or helpers, use `search_workspace` to find existing patterns and reuse them when they fit.\n'
        '- **After** `execute_workspace_mutation` or `plan_and_modify` returns, for each touched **Python** path you '
        'care about, call `lsp_get_diagnostics` (use `refresh_from_workspace=true` when you need the workspace on disk) '
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
