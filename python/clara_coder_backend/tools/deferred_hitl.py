"""Deferred execute-tool HITL gate (tools layer; orchestrators confirm via accept-command)."""

from __future__ import annotations

import uuid
from contextvars import ContextVar
from typing import Any

from clara_coder_backend.domain import SessionState
from clara_coder_backend.runtime.admin_exec import elevation_privilege_label
from clara_coder_backend.session.pause import stage_hitl_request

ACCEPT_COMMAND_KIND_DEFERRED_TOOL = 'deferred_tool'
ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL = 'admin_elevation_tool'

deferred_tool_hitl_bypass: ContextVar[bool] = ContextVar('deferred_tool_hitl_bypass', default=False)

DEFERRED_HITL_TOOL_NAMES: frozenset[str] = frozenset(
    {
        'run_command',
        'web_search',
        'fetch_url',
        'screenshot_webpage',
    }
)

__all__ = [
    'ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL',
    'ACCEPT_COMMAND_KIND_DEFERRED_TOOL',
    'DEFERRED_HITL_TOOL_NAMES',
    'deferred_tool_hitl_bypass',
    'maybe_await_hitl_for_admin_elevation',
    'maybe_await_hitl_for_deferred_tool',
]


def _presentation(tool_name: str, tool_input: dict[str, Any]) -> tuple[str, str, str, list[str]]:
    if tool_name == 'run_command':
        command = str(tool_input.get('command') or '').strip()
        cwd = str(tool_input.get('cwd') or '').strip()
        details = [f'Working directory: `{cwd or "."}`']
        if bool(tool_input.get('elevate')):
            details.append(f'Elevation: `{elevation_privilege_label()}`')
        return (
            'Run terminal command',
            'Run a shell command in the workspace as a managed background job.',
            command or '(empty command)',
            details,
        )
    if tool_name == 'web_search':
        from clara_coder_backend.tools.redact import redact_emails
        from clara_coder_backend.tools.web_search import outbound_user_agent

        # Show what will actually leave the machine, not the raw tool call.
        query, redacted = redact_emails(str(tool_input.get('query') or '').strip())
        limit = tool_input.get('limit')
        details = [f'Query: `{query}`'] if query else []
        if limit is not None:
            details.append(f'Limit: `{limit}`')
        details.append(f'User-Agent: `{outbound_user_agent()}`')
        if redacted:
            details.append(f'Email addresses redacted: `{redacted}`')
        return (
            'Web search',
            'Search the web with the configured search backend.',
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
    if tool_name == 'screenshot_webpage':
        from clara_coder_backend.tools.screenshot_webpage import screenshot_user_agent

        url = str(tool_input.get('url') or '')
        user_agent, error = screenshot_user_agent()
        details = [
            f'URL: `{url}`',
            f'Viewport: `{tool_input.get("width", 1280)} × {tool_input.get("height", 800)}`',
            f'User-Agent: `{user_agent}`' if not error else 'User-Agent: invalid (capture will be blocked)',
            'Sandbox: isolated, static capture of public HTTP(S) pages/images; no interactive browsing.',
        ]
        return (
            'Screenshot webpage',
            'Capture a public webpage or direct online image for display in the reply.',
            url or '(empty url)',
            details,
        )
    return (
        'Run tool',
        f'Execute `{tool_name}` in the active workspace.',
        tool_name,
        [],
    )


def maybe_await_hitl_for_admin_elevation(
    session: SessionState,
    *,
    tool_name: str,
    tool_input: dict[str, Any] | None = None,
) -> str:
    """Stage the composer Admin grant card and pause until the user allows or cancels.

    Auto-apply does not skip this path: elevated ``run_command`` still asks the user
    to turn on the composer Admin chip before the helper starts.
    """

    inp = dict(tool_input or {})
    pending: dict[str, Any] = {
        'request_id': uuid.uuid4().hex,
        'kind': ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
        'title': 'Grant administrator access',
        'message': (
            'Allow this agent to run shell commands with administrator or root privileges '
            'for this conversation. A Windows UAC or polkit prompt will appear after you click Allow.'
        ),
        'confirm_label': 'Allow',
        'cancel_label': 'Cancel',
        'command_text': '',
        'details': [
            'Applies to this conversation only',
            'Approve the system prompt now to start the elevated helper',
            'Turn off Admin in the composer to revoke',
        ],
        'cancel_note': 'User declined administrator access for this agent.',
        'action': {
            'tool_name': tool_name,
            'tool_input': inp,
        },
    }
    stage_hitl_request(session, 'pending_accept_command_request', pending)
    return (
        'Pending user confirmation for administrator access. '
        'The UI will ask the user to enable Admin before this elevated command runs.'
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
    if deferred_tool_hitl_bypass.get():
        return None
    inp = dict(tool_input or {})
    if session.auto_apply_mode:
        # Auto Run: the one toggle that skips approval cards (edits never ask; they are reset after the turn).
        return None
    title, message, command_text, details = _presentation(tool_name, inp)
    pending: dict[str, Any] = {
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
    stage_hitl_request(session, 'pending_accept_command_request', pending)
    return (
        f'Pending user confirmation for `{tool_name}`. '
        'The UI will ask the user to confirm before this command runs.'
    )
