"""Per-server MCP trust. Allow-all overrides remembered denies."""

from __future__ import annotations

from typing import Literal

from clara_coder_backend.domain import RuntimeMcpServer

TrustDecision = Literal['allow', 'deny', 'ask']

MCP_ACCEPT_KIND = 'mcp_tool'


def trust_decision(server: RuntimeMcpServer, tool_name: str) -> TrustDecision:
    """What to do before calling ``tool_name`` on ``server``."""

    if server.trust == 'allow-all':
        return 'allow'
    remembered = server.tool_decisions.get(tool_name)
    if remembered == 'allow':
        return 'allow'
    if remembered == 'deny':
        return 'deny'
    return 'ask'


def denial_message(server_name: str, tool_name: str) -> str:
    label = server_name.strip() or 'MCP server'
    return f'Tool `{tool_name}` on MCP server `{label}` is denied.'


def find_mcp_server(server_id: str) -> RuntimeMcpServer | None:
    from clara_coder_backend.session.state import runtime_config

    for server in runtime_config.mcp_servers:
        if server.id == server_id:
            return server
    return None


def set_server_trust(server_id: str, trust: str) -> None:
    server = find_mcp_server(server_id)
    if server is None:
        return
    server.trust = 'allow-all' if trust == 'allow-all' else 'ask'


def set_tool_decision(server_id: str, tool_name: str, decision: str) -> None:
    server = find_mcp_server(server_id)
    if server is None or not tool_name:
        return
    if decision not in ('allow', 'deny'):
        server.tool_decisions.pop(tool_name, None)
        return
    server.tool_decisions[tool_name] = decision
