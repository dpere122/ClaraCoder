"""Generic HITL accept-command payloads and execution helpers."""

from __future__ import annotations

from typing import Any

from clara_coder_backend.domain import SessionState

ACCEPT_COMMAND_KIND_PYTHON_DEPENDENCY = 'python_dependency'
ACCEPT_COMMAND_KIND_NODE_DEPENDENCY = 'node_dependency'
ACCEPT_COMMAND_KIND_ANGULAR_CLI = 'angular_cli'
ACCEPT_COMMAND_KIND_PROCESS_KILL = 'process_kill'
ACCEPT_COMMAND_KIND_DEFERRED_TOOL = 'deferred_tool'

__all__ = [
    'ACCEPT_COMMAND_KIND_ANGULAR_CLI',
    'ACCEPT_COMMAND_KIND_DEFERRED_TOOL',
    'ACCEPT_COMMAND_KIND_NODE_DEPENDENCY',
    'ACCEPT_COMMAND_KIND_PROCESS_KILL',
    'ACCEPT_COMMAND_KIND_PYTHON_DEPENDENCY',
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
) -> str:
    """Execute or cancel the current generic accept-command request."""

    pending = session.pending_accept_command_request
    if not pending:
        return ''
    if request_id and pending.get('request_id') != request_id:
        session.pending_accept_command_request = None
        return 'Command confirmation ignored (stale or mismatched request).'
    session.pending_accept_command_request = None
    if not confirm:
        return str(pending.get('cancel_note') or 'User cancelled the requested command.')

    kind = str(pending.get('kind') or '')
    if kind == ACCEPT_COMMAND_KIND_PYTHON_DEPENDENCY:
        from clara_coder_backend.tools.python_deps import execute_pending_python_dependency_request

        return await execute_pending_python_dependency_request(session, pending)
    if kind == ACCEPT_COMMAND_KIND_NODE_DEPENDENCY:
        from clara_coder_backend.tools.node_deps import execute_pending_node_dependency_request

        return await execute_pending_node_dependency_request(session, pending)
    if kind == ACCEPT_COMMAND_KIND_ANGULAR_CLI:
        from clara_coder_backend.tools.angular_cli import execute_pending_angular_cli_request

        return await execute_pending_angular_cli_request(session, pending)
    if kind == ACCEPT_COMMAND_KIND_PROCESS_KILL:
        from clara_coder_backend.tools.process import execute_pending_process_kill_request

        return await execute_pending_process_kill_request(session, pending)
    if kind == ACCEPT_COMMAND_KIND_DEFERRED_TOOL:
        from clara_coder_backend.deferred_tool_hitl import execute_pending_deferred_tool

        return await execute_pending_deferred_tool(session, pending)
    return f'Command confirmation failed: unsupported request kind `{kind or "unknown"}`.'
