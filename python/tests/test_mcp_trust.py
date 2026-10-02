"""MCP tool names and the trust gate. No live server."""

from __future__ import annotations

import pytest

from clara_coder_backend.domain import RuntimeMcpServer, SessionState
from clara_coder_backend.mcp.names import bound_mcp_tool_name, is_mcp_tool_name, sanitize_mcp_token
from clara_coder_backend.mcp.tools import execute_mcp_tool_decision, stage_mcp_tool_approval
from clara_coder_backend.mcp.trust import denial_message, set_server_trust, set_tool_decision, trust_decision
from clara_coder_backend.session.state import runtime_config


def test_bound_names_are_prefixed_and_bounded() -> None:
    assert sanitize_mcp_token('My Server!') == 'My_Server'
    name = bound_mcp_tool_name('github', 'search')
    assert name == 'mcp__github__search'
    assert is_mcp_tool_name(name)
    long_name = bound_mcp_tool_name('s' * 40, 't' * 40)
    assert long_name.startswith('mcp__')
    assert len(long_name) <= 64


def test_allow_all_overrides_a_remembered_deny() -> None:
    server = RuntimeMcpServer(id='gh', name='GitHub', trust='ask', tool_decisions={'search': 'deny'})
    assert trust_decision(server, 'search') == 'deny'
    assert trust_decision(server, 'other') == 'ask'
    server.trust = 'allow-all'
    assert trust_decision(server, 'search') == 'allow'
    assert 'denied' in denial_message('GitHub', 'search')


def test_turning_allow_all_off_returns_to_remembered_decisions() -> None:
    server = RuntimeMcpServer(id='gh', name='GitHub', trust='allow-all', tool_decisions={'search': 'deny', 'read': 'allow'})
    server.trust = 'ask'
    assert trust_decision(server, 'search') == 'deny'
    assert trust_decision(server, 'read') == 'allow'
    assert trust_decision(server, 'new') == 'ask'


@pytest.mark.asyncio(loop_scope='function')
async def test_mcp_decision_remember_allow_deny_and_allow_all(monkeypatch: pytest.MonkeyPatch) -> None:
    previous = list(runtime_config.mcp_servers)
    runtime_config.mcp_servers = [
        RuntimeMcpServer(id='srv', name='Fixture', trust='ask', tool_decisions={}),
    ]
    calls: list[tuple[str, str, dict]] = []

    async def _fake_call(server_id: str, tool_name: str, arguments: dict) -> str:
        calls.append((server_id, tool_name, arguments))
        return 'ran'

    monkeypatch.setattr('clara_coder_backend.mcp.manager.mcp_manager.call_tool', _fake_call)
    try:
        session = SessionState()
        pending_message = stage_mcp_tool_approval(
            session,
            server=runtime_config.mcp_servers[0],
            tool_name='ping',
            arguments={'text': 'hi'},
        )
        assert 'Pending user confirmation' in pending_message
        pending = session.pending_accept_command_request
        assert pending is not None
        assert pending['kind'] == 'mcp_tool'

        dismissed = await execute_mcp_tool_decision(pending, confirm=False, grant_session=False, remember_deny=False)
        assert 'not remembered' in dismissed
        assert runtime_config.mcp_servers[0].tool_decisions == {}
        assert calls == []

        denied = await execute_mcp_tool_decision(pending, confirm=False, grant_session=False, remember_deny=True)
        assert 'denied' in denied
        assert runtime_config.mcp_servers[0].tool_decisions['ping'] == 'deny'

        set_tool_decision('srv', 'ping', 'allow')
        allowed = await execute_mcp_tool_decision(pending, confirm=True, grant_session=False, remember_deny=False)
        assert allowed == 'ran'
        assert calls == [('srv', 'ping', {'text': 'hi'})]

        await execute_mcp_tool_decision(pending, confirm=False, grant_session=True, remember_deny=False)
        assert runtime_config.mcp_servers[0].trust == 'allow-all'
        set_server_trust('srv', 'ask')
        assert runtime_config.mcp_servers[0].trust == 'ask'
    finally:
        runtime_config.mcp_servers = previous
