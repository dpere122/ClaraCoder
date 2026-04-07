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


def _outer_agent_operational_block(apply_mode: bool) -> str:
    """Outer Clara: reads/search; ``modify_workspace`` when Editor on (mutations in nested specialists)."""
    base = (
        'Operational guidance:\n'
        '- For codebase questions, inspect the workspace before making claims.\n'
        '- If a tool returns partial data, say what is missing.\n'
        '- When your answer refers to code or files, name the relevant paths clearly.\n'
        '- Match shell guidance to the detected host OS; do not assume Bash is available on Windows.\n'
        '- If no workspace is loaded, say that no local files were available.\n'
        '- Read-only inspection: workspace tree and live state are in your system instructions above; use '
        '`list_workspace_directory`, `read_workspace_file`, and `search_workspace` to inspect files. '
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
        + '- Editor mode is on: you have read/search tools plus `modify_workspace`. '
        'Read and inspect relevant files yourself first, then call `modify_workspace` with a clear `task_summary` '
        'that includes the goal, constraints, paths, and any file content context you have already gathered. '
        'You cannot call edit or delete tools directly\u2014use `modify_workspace` for any workspace mutation. '
        'The user may review diffs or confirm deletes in the UI unless auto-apply is enabled.\n'
        '- After `modify_workspace` returns, answer the user with a concise summary of outcomes (files touched, '
        'key edits or findings). Do not paste raw nested output or token-by-token detail.\n'
    )


def build_system_prompt(session: SessionState, apply_mode: bool) -> str:
    """Assemble Clara's system prompt: role, tools policy, connection, OS, workspace."""
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
        f'{_outer_agent_operational_block(apply_mode)}'
        f'{workspace_hint}'
        f'{_qwen_optimize_suffix()}'
    )
