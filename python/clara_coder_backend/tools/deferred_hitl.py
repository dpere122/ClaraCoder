"""Deferred execute-tool HITL gate (tools layer; orchestrators confirm via accept-command)."""

from __future__ import annotations

import json
import uuid
from contextvars import ContextVar
from typing import Any

from clara_coder_backend.domain import SessionState

ACCEPT_COMMAND_KIND_DEFERRED_TOOL = 'deferred_tool'

deferred_tool_hitl_bypass: ContextVar[bool] = ContextVar('deferred_tool_hitl_bypass', default=False)

DEFERRED_HITL_TOOL_NAMES: frozenset[str] = frozenset(
    {
        'run_staging_overlay_command',
        'run_command',
        'web_search',
        'fetch_url',
    }
)

__all__ = [
    'ACCEPT_COMMAND_KIND_DEFERRED_TOOL',
    'DEFERRED_HITL_TOOL_NAMES',
    'deferred_tool_hitl_bypass',
    'maybe_await_hitl_for_deferred_tool',
]


def _presentation(tool_name: str, tool_input: dict[str, Any]) -> tuple[str, str, str, list[str]]:
    if tool_name == 'run_command':
        command = str(tool_input.get('command') or '').strip()
        cwd = str(tool_input.get('cwd') or '').strip()
        details = [f'Working directory: `{cwd or "."}`']
        return (
            'Run terminal command',
            'Run a shell command in the workspace as a managed background job.',
            command or '(empty command)',
            details,
        )
    if tool_name == 'run_staging_overlay_command':
        argv_json = str(tool_input.get('command_argv_json') or '[]')
        cwd = str(tool_input.get('cwd_relative') or '').strip()
        try:
            argv = json.loads(argv_json)
            rendered = ' '.join(str(a) for a in argv) if isinstance(argv, list) else argv_json
        except json.JSONDecodeError:
            rendered = argv_json
        details = []
        if cwd:
            details.append(f'Working directory: `{cwd}`')
        return (
            'Run staging overlay command',
            'Execute a command in the staging overlay (workspace + pending drafts) or workspace when in direct mode.',
            rendered,
            details,
        )
    if tool_name == 'web_search':
        query = str(tool_input.get('query') or '').strip()
        limit = tool_input.get('limit')
        details = [f'Query: `{query}`'] if query else []
        if limit is not None:
            details.append(f'Limit: `{limit}`')
        return (
            'Web search (SearXNG)',
            'Search the web via your configured SearXNG instance.',
            query or '(empty query)',
            details,
        )
    if tool_name == 'fetch_url':
        url = str(tool_input.get('url') or '').strip()
        details = [f'URL: `{url}`'] if url else []
        return (
            'Fetch URL',
            'Download a public http(s) page and return truncated text.',
            url or '(empty url)',
            details,
        )
    return (
        'Run tool',
        f'Execute `{tool_name}` in the active workspace.',
        tool_name,
        [],
    )


def maybe_await_hitl_for_deferred_tool(
    session: SessionState,
    *,
    tool_name: str,
    tool_input: dict[str, Any] | None = None,
) -> str | None:
    """Stage accept-command HITL and return the pending tool message, or None to run immediately."""

    if tool_name not in DEFERRED_HITL_TOOL_NAMES:
        return None
    if session.auto_apply_mode or deferred_tool_hitl_bypass.get():
        return None
    inp = dict(tool_input or {})
    title, message, command_text, details = _presentation(tool_name, inp)
    session.pending_accept_command_request = {
        'request_id': uuid.uuid4().hex,
        'kind': ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
        'title': title,
        'message': message,
        'confirm_label': 'Run',
        'cancel_label': 'Cancel',
        'command_text': command_text,
        'details': details,
        'cancel_note': f'User cancelled the pending command: {title}.',
        'action': {
            'tool_name': tool_name,
            'tool_input': inp,
        },
    }
    return (
        f'Pending user confirmation for `{tool_name}`. '
        'The UI will ask the user to confirm before this command runs.'
    )
