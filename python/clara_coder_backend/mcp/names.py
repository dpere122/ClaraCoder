"""Bound MCP tool names. Prefixed so they cannot collide with Clara tools."""

from __future__ import annotations

import hashlib
import re

MCP_TOOL_PREFIX = 'mcp__'
_MAX_LEN = 64
_SAFE = re.compile(r'[^A-Za-z0-9_-]+')


def sanitize_mcp_token(raw: str) -> str:
    """Collapse a server id or remote tool name to a tool-name token."""

    text = _SAFE.sub('_', (raw or '').strip()).strip('_')
    return text or 'tool'


def bound_mcp_tool_name(server_id: str, tool_name: str) -> str:
    """Return ``mcp__{serverId}__{toolName}``, shortened when the pair is too long."""

    sid = sanitize_mcp_token(server_id)
    tool = sanitize_mcp_token(tool_name)
    name = f'{MCP_TOOL_PREFIX}{sid}__{tool}'
    if len(name) <= _MAX_LEN:
        return name
    digest = hashlib.sha256(name.encode('utf-8')).hexdigest()[:8]
    keep = _MAX_LEN - len(digest) - 1
    return f'{name[:keep]}_{digest}'


def is_mcp_tool_name(name: str) -> bool:
    return (name or '').startswith(MCP_TOOL_PREFIX)
