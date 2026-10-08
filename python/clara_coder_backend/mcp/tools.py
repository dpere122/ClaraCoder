"""LangChain tools bound from connected MCP servers."""

from __future__ import annotations

import json
import uuid
from typing import Any

from langchain_core.tools import StructuredTool

from clara_coder_backend.domain import RuntimeMcpServer, SessionState
from clara_coder_backend.mcp.manager import mcp_manager
from clara_coder_backend.mcp.names import bound_mcp_tool_name
from clara_coder_backend.mcp.trust import denial_message, trust_decision

_INJECTED = frozenset({'config', 'callbacks', 'run_manager'})


def _input_schema(tool: Any) -> dict[str, Any]:
    schema = getattr(tool, 'inputSchema', None)
    if isinstance(schema, dict) and schema:
        return schema
    return {'type': 'object', 'properties': {}}


def _description(server: RuntimeMcpServer, tool: Any) -> str:
    label = (server.name or server.id or 'MCP').strip()
    text = str(getattr(tool, 'description', '') or getattr(tool, 'name', '') or '').strip()
    if not text:
        text = str(getattr(tool, 'name', '') or 'tool')
    return f'{label}: {text}'


def stage_mcp_tool_approval(
    session: SessionState,
    *,
    server: RuntimeMcpServer,
    tool_name: str,
    arguments: dict[str, Any],
) -> str:
    """Pause the turn on the accept-command card. Dismiss does not remember."""

    rendered = json.dumps(arguments, ensure_ascii=False)
    if len(rendered) > 2000:
        rendered = rendered[:2000] + '…'
    label = (server.name or server.id).strip()
    pending: dict[str, Any] = {
        'request_id': uuid.uuid4().hex,
        'kind': 'mcp_tool',
        'title': f'Allow {tool_name}',
        'message': f'{label} wants to run `{tool_name}`. Allow remembers this tool. Deny remembers a refusal.',
        'confirm_label': 'Allow',
        'confirm_session_label': 'Allow all tools from this server',
        'cancel_label': 'Deny',
        'command_text': rendered,
        'details': [f'Server: {label}'],
        'cancel_note': 'User dismissed the MCP tool request. The choice was not remembered.',
        'mcp_server_id': server.id,
        'mcp_tool_name': tool_name,
        'action': {
            'server_id': server.id,
            'tool_name': tool_name,
            'arguments': arguments,
        },
    }
    session.pending_accept_command_request = pending
    return f'Pending user confirmation for MCP tool `{tool_name}` on `{label}`.'


def _arguments(kwargs: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in kwargs.items() if key not in _INJECTED}


async def execute_mcp_tool_decision(
    pending: dict[str, Any],
    *,
    confirm: bool,
    grant_session: bool,
    remember_deny: bool,
) -> str:
    """Apply Allow, Deny, or Allow-all, then run the tool when it is permitted."""

    from clara_coder_backend.mcp.trust import set_server_trust, set_tool_decision

    action = pending.get('action') if isinstance(pending.get('action'), dict) else {}
    server_id = str(action.get('server_id') or '')
    tool_name = str(action.get('tool_name') or '')
    arguments = action.get('arguments') if isinstance(action.get('arguments'), dict) else {}
    if grant_session:
        set_server_trust(server_id, 'allow-all')
    elif confirm:
        set_tool_decision(server_id, tool_name, 'allow')
    elif remember_deny:
        set_tool_decision(server_id, tool_name, 'deny')
        server = (pending.get('details') or [''])[0]
        label = server.replace('Server: ', '').strip() or server_id
        return denial_message(label, tool_name)
    else:
        return str(pending.get('cancel_note') or 'User dismissed the MCP tool request. The choice was not remembered.')
    return await mcp_manager.call_tool(server_id, tool_name, arguments)


def bound_mcp_tools() -> list[StructuredTool]:
    """Full schemas for every tool on a connected, enabled server."""

    used: set[str] = set()
    tools: list[StructuredTool] = []
    for server, remote in mcp_manager.listed_tools():
        remote_name = str(getattr(remote, 'name', '') or '').strip()
        if not remote_name:
            continue
        name = bound_mcp_tool_name(server.id, remote_name)
        if name in used:
            suffix = 2
            while f'{name}_{suffix}' in used:
                suffix += 1
            name = f'{name}_{suffix}'
        used.add(name)
        tools.append(_one_tool(server, remote_name, name, remote))
    return tools


def _one_tool(server: RuntimeMcpServer, remote_name: str, bound_name: str, remote: Any) -> StructuredTool:
    server_id = server.id

    async def _invoke(**kwargs: Any) -> str:
        from clara_coder_backend.mcp.trust import find_mcp_server
        from clara_coder_backend.session.state import current_session_id, get_session

        current = find_mcp_server(server_id)
        if current is None or not current.enabled:
            return 'MCP server is not configured.'
        arguments = _arguments(kwargs)
        decision = trust_decision(current, remote_name)
        if decision == 'deny':
            return denial_message(current.name or current.id, remote_name)
        if decision == 'ask':
            session_id = current_session_id.get()
            if not session_id:
                return 'No active conversation is available to approve this MCP tool.'
            session = get_session(session_id)
            return stage_mcp_tool_approval(
                session,
                server=current,
                tool_name=remote_name,
                arguments=arguments,
            )
        return await mcp_manager.call_tool(server_id, remote_name, arguments)

    return StructuredTool(
        name=bound_name,
        description=_description(server, remote),
        args_schema=_input_schema(remote),
        coroutine=_invoke,
    )
