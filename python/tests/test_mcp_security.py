"""MCP hardening: child env, static headers, OAuth URL binding, and read-only tool surfaces."""

from __future__ import annotations

import pytest
from langchain_core.tools import StructuredTool

from clara_coder_backend.domain import RuntimeMcpServer
from clara_coder_backend.hitl.tool_registry import planner_discovery_tools_and_map, worker_tools_and_map
from clara_coder_backend.mcp.manager import _env_overlay, _header_map, mcp_manager
from clara_coder_backend.mcp.oauth import (
    MemoryTokenStorage,
    _client_info_from_server,
    _token_from_server,
    has_usable_oauth_token,
    stored_from_memory,
)
from clara_coder_backend.session.state import get_session, runtime_config


def _oauth_server(url: str, issued_for: str) -> RuntimeMcpServer:
    return RuntimeMcpServer(
        id='remote',
        name='Remote',
        enabled=True,
        transport='http',
        url=url,
        http_auth='oauth',
        oauth_access_token='access-a',
        oauth_refresh_token='refresh-a',
        oauth_client_id='client-a',
        oauth_client_secret='secret-a',
        oauth_server_url=issued_for,
    )


def test_stdio_env_is_only_the_server_overlay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_SIDECAR_TOKEN', 'sidecar-secret')
    monkeypatch.setenv('HF_TOKEN', 'hf-secret')
    server = RuntimeMcpServer(id='gh', env=[('GITHUB_TOKEN', 'ghp'), ('  ', 'ignored')])
    assert _env_overlay(server) == {'GITHUB_TOKEN': 'ghp'}
    assert _env_overlay(RuntimeMcpServer(id='bare')) is None


def test_static_headers_only_sent_in_headers_mode() -> None:
    server = RuntimeMcpServer(id='api', transport='http', http_auth='headers', headers=[('Authorization', 'Bearer x')])
    assert _header_map(server) == {'Authorization': 'Bearer x'}
    server.http_auth = 'none'
    assert _header_map(server) is None
    server.http_auth = 'oauth'
    assert _header_map(server) is None


def test_oauth_credentials_are_bound_to_the_issuing_url() -> None:
    same = _oauth_server('https://a.example/mcp/', 'https://a.example/mcp')
    assert has_usable_oauth_token(same)
    assert _token_from_server(same) is not None
    assert _client_info_from_server(same, 'http://127.0.0.1:5000/callback') is not None

    moved = _oauth_server('https://b.example/mcp', 'https://a.example/mcp')
    assert not has_usable_oauth_token(moved)
    assert _token_from_server(moved) is None
    assert _client_info_from_server(moved, 'http://127.0.0.1:5000/callback') is None

    legacy = _oauth_server('https://a.example/mcp', '')
    assert _token_from_server(legacy) is None


def test_stored_tokens_record_the_sign_in_url() -> None:
    stored = stored_from_memory(MemoryTokenStorage(), server_url=' https://a.example/mcp ')
    assert stored.server_url == 'https://a.example/mcp'
    assert stored.as_public_dict()['serverUrl'] == 'https://a.example/mcp'


def test_status_asks_for_sign_in_when_tokens_belong_to_another_url() -> None:
    previous = list(runtime_config.mcp_servers)
    runtime_config.mcp_servers = [_oauth_server('https://b.example/mcp', 'https://a.example/mcp')]
    try:
        row = mcp_manager.status()['servers'][0]
        assert row['needsSignIn'] is True
    finally:
        runtime_config.mcp_servers = previous


def test_read_only_surfaces_do_not_bind_mcp_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _noop(**_kwargs: object) -> str:
        return 'ran'

    fake = StructuredTool.from_function(
        coroutine=_noop,
        name='mcp__srv__write_file',
        description='Writes a file.',
        args_schema={'type': 'object', 'properties': {}},
    )
    monkeypatch.setattr('clara_coder_backend.mcp.tools.bound_mcp_tools', lambda: [fake])

    session = get_session('mcp-read-only-surfaces')
    assert fake.name not in {t.name for t in worker_tools_and_map(False, session=session)[0]}
    assert fake.name not in planner_discovery_tools_and_map(session=session)[1]
    assert fake.name in worker_tools_and_map(True, session=session)[1]
