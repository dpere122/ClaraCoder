"""LangChain message conversion, assistant text extraction, and system prompt.

Turns stored session history dicts into :class:`~langchain_core.messages.BaseMessage`
instances and builds the long system prompt (workspace + host + connection hints).
"""

from __future__ import annotations

import re
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from nemo_backend.domain import SessionState
from nemo_backend.model_tuning import qwen_optimize_profile_active, qwen_system_prompt_suffix
from nemo_backend.state import get_active_connection, runtime_config

# Precompiled patterns for detecting "pseudo" tool syntax in plain model text.
_RE_PSEUDO_FUNCTION_TAG = re.compile(r'<\s*function\s*=', re.IGNORECASE)
_RE_PSEUDO_PARAMETER_TAG = re.compile(r'<\s*parameter\s*=', re.IGNORECASE)


def session_to_messages(session: SessionState) -> list[BaseMessage]:
    """Map session.history entries to LangChain message objects for the LLM."""
    result: list[BaseMessage] = []
    for item in session.history:
        role = item.get('role', 'user')
        content = item.get('content', '')
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


def _workspace_hint(session: SessionState) -> str:
    if not session.workspace_path:
        return 'No workspace is attached to this conversation.'
    return (
        f'Workspace path: {session.workspace_path}\n\n'
        f'Workspace tree snapshot:\n{session.workspace_context or "[empty]"}\n\n'
        f'Workspace live state:\n{session.workspace_state or "[no recent file activity recorded]"}'
    )


def _connection_line(session: SessionState) -> str:
    connection = get_active_connection()
    return (
        f'Active model connection: {connection.name} ({connection.provider}, model={connection.model}).'
    )


def _qwen_optimize_suffix() -> str:
    if qwen_optimize_profile_active(get_active_connection()):
        return qwen_system_prompt_suffix()
    return ''


def _os_hint_line() -> str:
    host = runtime_config.host
    if not host.platform:
        return 'Host operating system: unavailable.'
    return (
        f'Host operating system: {host.label or host.platform} '
        f'(platform={host.platform}, release={host.release or "unknown"}, '
        f'version={host.version or "unknown"}, arch={host.arch or "unknown"}).'
    )


def _worker_operational_block(apply_mode: bool) -> str:
    """``apply_mode`` mirrors Editor mode in the app: when False, write/edit tools are not bound."""
    base = (
        'Operational guidance:\n'
        '- For codebase questions, inspect the workspace before making claims.\n'
        '- If a tool returns partial data, say what is missing.\n'
        '- When your answer refers to code or files, name the relevant paths clearly.\n'
        '- Match shell guidance to the detected host OS; do not assume Bash is available on Windows.\n'
        '- If no workspace is loaded, say that no local files were available.\n'
        '- Read-only inspection: use list_workspace_directory, read_workspace_file, search_workspace, get_workspace_snapshot. '
        'For `.pdf` files, `read_workspace_file` treats start_line/end_line as 1-based page numbers (extracted text per page).\n'
    )
    if not apply_mode:
        return (
            base
            + '- Editor mode is off: workspace write and edit-proposal tools are not available for this turn. '
            'Use read-only tools. Describe suggested changes in prose if useful, and mention that the user can enable '
            'Editor in the toolbar when they want you to open diffs or propose patches from chat.\n'
        )

    edit_tools = (
        '- Editor mode is on: write tools are bound—call them only when the task warrants changing workspace files, not on every turn.\n'
        '- Propose edits with separate tools (pick one per change): '
        '`replace_workspace_line_range` for localized edits (start_line, end_line, new_snippet; 1-based inclusive, '
        'same numbering as read_workspace_file)—preferred for small patches; '
        '`apply_workspace_full_file` for new files or whole-file rewrites (new_content); '
        '`replace_workspace_snippet` for search-replace when a line block is awkward '
        '(old_snippet must match uniquely; use read_workspace_file with include_line_numbers false so old_snippet '
        'does not include `N: ` prefixes from numbered reads). '
    )
    if runtime_config.tools.edit_tools_strict:
        edit_tools = (
            '- Editor mode is on: write tools are bound—use them only when the task warrants file changes.\n'
            '- Propose edits with `replace_workspace_line_range` (localized; start_line, end_line, new_snippet) '
            'or `apply_workspace_full_file` (new_content). Snippet replace is disabled in this deployment—do not call '
            '`replace_workspace_snippet`. '
        )
    return (
        base
        + edit_tools
        + 'Each edit tool opens a side-by-side diff and the user applies it in the UI—do not claim the file was written until then. '
        'If the user enabled auto-apply in the app, the tool writes the file immediately and the tool summary will state that.\n'
    )


def _manager_editor_mode_clause(apply_mode: bool) -> str:
    if apply_mode:
        return (
            '- Editor mode is on: you may call `delegate_workspace_task` when workspace work is best handled by the worker '
            '(e.g. multi-step edits). The worker has the same workspace read/edit tools as you except it cannot delegate—'
            'only you may call `delegate_workspace_task`.\n'
        )
    return (
        '- Editor mode is off: you have read/search/list/snapshot tools only—use them directly to answer. '
        'Do not attempt delegation. If the user wants patches from chat, ask them to enable Editor in the toolbar.\n'
    )


def build_worker_system_prompt(session: SessionState, apply_mode: bool) -> str:
    """System prompt for the delegated workspace worker (full workspace tools; no delegation)."""
    workspace_hint = _workspace_hint(session)
    return (
        'You are Clara’s workspace worker agent. You execute a single delegated task using workspace tools. '
        'You do not see the full user chat—only the task message from the manager—and you do not have `delegate_workspace_task` '
        '(only the manager may delegate). Invoke tools only through structured tool/function calling—never XML or <tool_call> text.\n\n'
        f'{_connection_line(session)}\n\n'
        f'{_os_hint_line()}\n\n'
        f'{_worker_operational_block(apply_mode)}'
        f'{workspace_hint}'
        f'{_qwen_optimize_suffix()}'
    )


def build_manager_system_prompt(session: SessionState, apply_mode: bool) -> str:
    """System prompt for the manager agent (reads + optional delegation + user-facing reasoning)."""
    workspace_hint = _workspace_hint(session)
    return (
        'You are Clara (manager agent) in an Electron desktop coding assistant. '
        'You see the conversation history and speak directly to the user.\n\n'
        '- Answer greetings, high-level conceptual questions, and tasks that clearly need no workspace access yourself.\n'
        '- You have workspace read tools: `get_workspace_snapshot`, `list_workspace_directory`, `read_workspace_file`, '
        '`search_workspace`. Use them for your own reasoning, previews, or follow-ups; you may also delegate so the worker '
        'can read and edit on your behalf.\n'
        f'{_manager_editor_mode_clause(apply_mode)}'
        '- When you delegate (Editor on), call `delegate_workspace_task` once with a clear `task_summary` (goal, constraints, '
        'paths or filenames). The worker can inspect the repo itself; add excerpts only when they help.\n'
        '- After the worker returns, synthesize a clear answer for the user from that result.\n'
        '- Use structured tool calls only—never fake tool syntax in plain text.\n\n'
        f'{_connection_line(session)}\n\n'
        f'{_os_hint_line()}\n\n'
        f'{workspace_hint}'
        f'{_qwen_optimize_suffix()}'
    )


def build_system_prompt(session: SessionState, apply_mode: bool) -> str:
    """Assemble Clara's system prompt: role, tools policy, connection, OS, workspace (single-agent mode)."""
    workspace_hint = _workspace_hint(session)
    return (
        'You are Clara, a proactive coding assistant inside an Electron desktop app. '
        'Use the available tools whenever a request depends on inspecting or searching the workspace. '
        'Invoke tools only through the chat model’s structured tool-calling channel (native tool/function calls)—'
        'never emit tool invocations as XML tags, <tool_call> blocks, or similar text; those are ignored by the runtime. '
        'Prefer quoting exact file paths, line numbers, commands, and concrete next steps. '
        'Keep answers concise but useful, and explain what you actually inspected.\n\n'
        f'{_connection_line(session)}\n\n'
        f'{_os_hint_line()}\n\n'
        f'{_worker_operational_block(apply_mode)}'
        f'{workspace_hint}'
        f'{_qwen_optimize_suffix()}'
    )
