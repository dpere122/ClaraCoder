"""Generic HITL accept-command payloads and execution helpers."""

from __future__ import annotations

from typing import Any

from clara_coder_backend.domain import SessionState
from clara_coder_backend.tools.deferred_hitl import (
    ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
    ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
)

__all__ = [
    'ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL',
    'ACCEPT_COMMAND_KIND_DEFERRED_TOOL',
    'accept_command_sse_payload',
    'execute_pending_accept_command_decision',
]


def accept_command_sse_payload(pending: dict[str, Any]) -> dict[str, Any]:
    """Shape for SSE `acceptCommand` / frontend `AcceptCommandPayload`."""

    payload: dict[str, Any] = {
        'version': 1,
        'requestId': str(pending.get('request_id') or ''),
        'kind': str(pending.get('kind') or ''),
        'title': str(pending.get('title') or ''),
        'message': str(pending.get('message') or ''),
        'confirmLabel': str(pending.get('confirm_label') or 'Confirm'),
        'cancelLabel': str(pending.get('cancel_label') or 'Cancel'),
        'commandText': str(pending.get('command_text') or ''),
        'details': [str(item) for item in (pending.get('details') or []) if str(item).strip()],
    }
    session_label = str(pending.get('confirm_session_label') or '').strip()
    if session_label:
        payload['confirmSessionLabel'] = session_label
    mcp_server_id = str(pending.get('mcp_server_id') or '').strip()
    if mcp_server_id:
        payload['mcpServerId'] = mcp_server_id
    mcp_tool_name = str(pending.get('mcp_tool_name') or '').strip()
    if mcp_tool_name:
        payload['mcpToolName'] = mcp_tool_name

    risk_status = pending.get('risk_assessment_status')
    if risk_status:
        payload['riskAssessmentStatus'] = str(risk_status)
        if risk_status == 'ok':
            payload['riskLevel'] = pending.get('risk_level')
            payload['riskDescription'] = pending.get('risk_description')

    return payload


async def execute_pending_accept_command_decision(
    session: SessionState,
    *,
    confirm: bool,
    request_id: str | None,
    grant_session: bool = False,
    remember_deny: bool = False,
) -> str:
    """Execute or cancel the current generic accept-command request."""

    pending = session.pending_accept_command_request
    if not pending:
        return ''
    if request_id and pending.get('request_id') != request_id:
        session.pending_accept_command_request = None
        return 'Command confirmation ignored (stale or mismatched request).'
    session.pending_accept_command_request = None
    kind = str(pending.get('kind') or '')
    if kind == 'mcp_tool':
        from clara_coder_backend.mcp.tools import execute_mcp_tool_decision

        return await execute_mcp_tool_decision(
            pending,
            confirm=confirm,
            grant_session=grant_session,
            remember_deny=remember_deny,
            session=session,
        )
    if not confirm:
        return str(pending.get('cancel_note') or 'User cancelled the requested command.')

    if grant_session:
        action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
        tool_input = action.get('tool_input') if isinstance(action.get('tool_input'), dict) else {}
        if str(action.get('tool_name') or '') == 'run_command' and bool(tool_input.get('elevate')):
            session.admin_elevation_granted = True

    if kind == ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL:
        from clara_coder_backend.hitl.deferred_tool_hitl import execute_pending_deferred_tool
        from clara_coder_backend.runtime.admin_exec import warmup_persistent_broker
        from clara_coder_backend.session.state import sessions

        sid = next((key for key, state in sessions.items() if state is session), '')
        err = await warmup_persistent_broker(sid) if sid else 'Tool error: no active session.'
        if err:
            return err
        session.admin_elevation_granted = True
        return await execute_pending_deferred_tool(session, pending)
    if kind == ACCEPT_COMMAND_KIND_DEFERRED_TOOL:
        from clara_coder_backend.hitl.deferred_tool_hitl import execute_pending_deferred_tool

        return await execute_pending_deferred_tool(session, pending)
    return f'Command confirmation failed: unsupported request kind `{kind or "unknown"}`.'
