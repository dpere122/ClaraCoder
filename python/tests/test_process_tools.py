"""Host process port search and kill tools."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from clara_coder_backend.accept_command import (
    ACCEPT_COMMAND_KIND_PROCESS_KILL,
    execute_pending_accept_command_decision,
)
from clara_coder_backend.tools.process import (
    kill_process_tool,
    parse_netstat_output,
    search_listening_ports,
    search_netstat_ports_tool,
)
from clara_coder_backend.state import get_session


def test_parse_windows_netstat_listening() -> None:
    sample = """
  TCP    0.0.0.0:4200           0.0.0.0:0              LISTENING       12345
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       6789
"""
    rows = search_listening_ports(sample, port=4200, platform='win32')
    assert len(rows) == 1
    assert rows[0].pid == 12345
    assert rows[0].local_address.endswith(':4200')


def test_parse_ss_output() -> None:
    sample = 'tcp   LISTEN 0      128    127.0.0.1:3000    0.0.0.0:*    users:(("node",pid=4242,fd=21))'
    rows = parse_netstat_output(sample, platform='linux')
    assert len(rows) == 1
    assert rows[0].pid == 4242


@pytest.mark.asyncio
async def test_search_netstat_ports_filters() -> None:
    fake_out = '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       99\n'
    with patch(
        'clara_coder_backend.tools.process._run_netstat',
        new=AsyncMock(return_value=(0, fake_out)),
    ):
        result = await search_netstat_ports_tool.ainvoke({'port': 8080})
    assert '8080' in result
    assert 'pid `99`' in result


@pytest.mark.asyncio
async def test_kill_process_always_pending() -> None:
    from clara_coder_backend.state import current_session_id

    sid = 'kill-hitl'
    token = current_session_id.set(sid)
    try:
        session = get_session(sid)
        session.pending_accept_command_request = None
        out = await kill_process_tool.ainvoke({'pid': 4242})
        assert 'Pending user confirmation' in out
        pending = session.pending_accept_command_request
        assert pending is not None
        assert pending['kind'] == ACCEPT_COMMAND_KIND_PROCESS_KILL
    finally:
        current_session_id.reset(token)


@pytest.mark.asyncio
async def test_kill_process_rejects_protected_pid() -> None:
    from clara_coder_backend.state import current_session_id

    token = current_session_id.set('kill-protected')
    try:
        out = await kill_process_tool.ainvoke({'pid': 4})
        assert 'protected' in out
    finally:
        current_session_id.reset(token)


@pytest.mark.asyncio
async def test_execute_pending_kill(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.state import current_session_id

    sid = 'kill-exec'
    token = current_session_id.set(sid)
    try:
        session = get_session(sid)
        session.pending_accept_command_request = {
            'request_id': 'abc',
            'kind': ACCEPT_COMMAND_KIND_PROCESS_KILL,
            'action': {'kind': 'kill_process', 'pid': 9999, 'force': True, 'kill_tree': True},
        }
        mock_kill = AsyncMock(return_value='killed')
        monkeypatch.setattr('clara_coder_backend.tools.process._execute_kill', mock_kill)
        result = await execute_pending_accept_command_decision(session, confirm=True, request_id='abc')
        assert result == 'killed'
        mock_kill.assert_awaited_once()
    finally:
        current_session_id.reset(token)
