"""Execute deferred workspace tools after the user confirms via the accept-command HITL card."""

from __future__ import annotations

from typing import Any

from clara_coder_backend.domain import SessionState
from clara_coder_backend.session.state import current_session_id, sessions
from clara_coder_backend.tools.deferred_hitl import (
    DEFERRED_HITL_TOOL_NAMES,
    deferred_tool_hitl_bypass,
    maybe_await_hitl_for_deferred_tool,
)

__all__ = [
    'DEFERRED_HITL_TOOL_NAMES',
    'deferred_tool_hitl_bypass',
    'execute_pending_deferred_tool',
    'maybe_await_hitl_for_deferred_tool',
]


def _session_id_for(session: SessionState) -> str:
    for sid, state in sessions.items():
        if state is session:
            return sid
    return ''


async def execute_pending_deferred_tool(session: SessionState, pending: dict[str, Any]) -> str:
    """Run a deferred tool after the user accepts the accept-command card."""

    action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
    tool_name = str(action.get('tool_name') or '')
    tool_input = action.get('tool_input') if isinstance(action.get('tool_input'), dict) else {}
    tool = _resolve_deferred_tool(tool_name)
    if tool is None:
        return f'Command confirmation failed: unsupported deferred tool `{tool_name or "unknown"}`.'
    sid = _session_id_for(session)
    sid_token = current_session_id.set(sid) if sid else None
    hitl_token = deferred_tool_hitl_bypass.set(True)
    try:
        result = await tool.ainvoke(tool_input)
        return str(result)
    finally:
        deferred_tool_hitl_bypass.reset(hitl_token)
        if sid_token is not None:
            current_session_id.reset(sid_token)


def _resolve_deferred_tool(tool_name: str) -> Any | None:
    if tool_name == 'run_command':
        from clara_coder_backend.tools.run_command import run_command_tool

        return run_command_tool
    if tool_name == 'web_search':
        from clara_coder_backend.tools.web_search import web_search_tool

        return web_search_tool
    if tool_name == 'fetch_url':
        from clara_coder_backend.tools.fetch_url import fetch_url_tool

        return fetch_url_tool
    return None
