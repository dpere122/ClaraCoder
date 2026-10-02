"""Stdio MCP adapter: list one tool and call it."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from clara_coder_backend.domain import RuntimeMcpServer
from clara_coder_backend.mcp.manager import mcp_manager
from clara_coder_backend.session.state import runtime_config

_FIXTURE = Path(__file__).with_name('mcp_stdio_fixture.py')


@pytest.mark.asyncio(loop_scope='function')
async def test_stdio_fixture_lists_and_calls_ping(tmp_path: Path) -> None:
    previous_servers = list(runtime_config.mcp_servers)
    previous_workspace = runtime_config.active_workspace_path
    runtime_config.mcp_servers = [
        RuntimeMcpServer(
            id='fixture',
            name='Fixture',
            enabled=True,
            trust='allow-all',
            transport='stdio',
            command=sys.executable,
            args=[str(_FIXTURE)],
        )
    ]
    runtime_config.active_workspace_path = str(tmp_path)
    try:
        await mcp_manager.reconcile()
        await mcp_manager.wait_until_settled(20)
        status = mcp_manager.status()
        row = next(item for item in status['servers'] if item['id'] == 'fixture')
        assert row['connected'], row['error']
        assert row['toolCount'] == 1
        from clara_coder_backend.mcp.tools import bound_mcp_tools

        bound = bound_mcp_tools()
        assert len(bound) == 1
        assert bound[0].name.startswith('mcp__fixture__ping')
        result = await bound[0].ainvoke({'text': 'hi'})
        assert result == 'pong:hi'
    finally:
        await mcp_manager.shutdown()
        runtime_config.mcp_servers = previous_servers
        runtime_config.active_workspace_path = previous_workspace
