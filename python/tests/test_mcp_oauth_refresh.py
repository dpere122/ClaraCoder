"""MCP OAuth refresh: Electron refreshes, Python never does and swaps new tokens in place."""

from __future__ import annotations

import time

import pytest

from clara_coder_backend.domain import RuntimeMcpServer
from clara_coder_backend.mcp import manager as manager_module
from clara_coder_backend.mcp.manager import LiveServer, _fingerprint, mcp_manager
from clara_coder_backend.mcp.oauth import (
    _token_from_server,
    build_oauth_provider,
    has_usable_oauth_token,
    oauth_refresh_settings,
)
from clara_coder_backend.routes.mcp import mcp_oauth_tokens
from clara_coder_backend.session.schemas import McpOAuthTokensRequest, McpOAuthTokensUpdateRequest
from clara_coder_backend.session.state import runtime_config

URL = 'https://mcp.example/mcp'


def _server(**overrides: object) -> RuntimeMcpServer:
    base = dict(
        id='remote',
        name='Remote',
        enabled=True,
        transport='http',
        url=URL,
        http_auth='oauth',
        oauth_access_token='access-1',
        oauth_refresh_token='refresh-1',
        oauth_expires_at=time.time() + 3600,
        oauth_client_id='client-1',
        oauth_server_url=URL,
    )
    base.update(overrides)
    return RuntimeMcpServer(**base)


def _connection_provider(server: RuntimeMcpServer):
    provider, _storage = build_oauth_provider(
        server, redirect_uri='http://127.0.0.1/callback', interactive=False, loopback=None
    )
    return provider


def test_expired_tokens_are_not_used() -> None:
    assert has_usable_oauth_token(_server())
    assert not has_usable_oauth_token(_server(oauth_expires_at=time.time() - 5))
    assert has_usable_oauth_token(_server(oauth_expires_at=0))


def test_python_never_holds_a_refresh_token() -> None:
    token = _token_from_server(_server())
    assert token is not None
    assert token.refresh_token is None
    provider = _connection_provider(_server())
    assert provider.context.storage.tokens.refresh_token is None


def test_sign_in_starts_without_stored_tokens_or_client() -> None:
    _provider, storage = build_oauth_provider(
        _server(), redirect_uri='http://127.0.0.1:5123/callback', interactive=True, loopback=None
    )
    assert storage.tokens is None
    assert storage.client_info is None


def test_refresh_settings_come_from_the_sign_in() -> None:
    from mcp.shared.auth import OAuthClientInformationFull, OAuthMetadata

    provider = _connection_provider(_server())
    assert oauth_refresh_settings(provider) == ('https://mcp.example/token', '', '')

    # What a finished sign-in leaves on the context: discovered metadata and the registered client.
    provider.context.oauth_metadata = OAuthMetadata(
        issuer='https://auth.example',
        authorization_endpoint='https://auth.example/authorize',
        token_endpoint='https://auth.example/oauth/token',
        response_types_supported=['code'],
    )
    provider.context.protocol_version = '2025-06-18'
    provider.context.client_info = OAuthClientInformationFull(
        client_id='client-1',
        client_secret='s3cret',
        redirect_uris=['http://127.0.0.1:5123/callback'],
        token_endpoint_auth_method='client_secret_basic',
    )
    assert oauth_refresh_settings(provider) == ('https://auth.example/oauth/token', URL, 'client_secret_basic')


def test_a_refresh_keeps_the_fingerprint_but_signing_in_changes_it() -> None:
    before = _fingerprint(_server(), '/ws')
    assert _fingerprint(_server(oauth_access_token='access-2'), '/ws') == before
    assert _fingerprint(_server(oauth_access_token=''), '/ws') != before


@pytest.mark.asyncio(loop_scope='function')
async def test_refreshed_tokens_reach_the_live_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    server = _server()
    previous = list(runtime_config.mcp_servers)
    runtime_config.mcp_servers = [server]
    live = LiveServer(fingerprint=_fingerprint(server, ''), connected=True, auth=_connection_provider(server))
    mcp_manager._live[server.id] = live
    reconciles: list[bool] = []
    monkeypatch.setattr(manager_module, 'schedule_mcp_reconcile', lambda: reconciles.append(True))
    monkeypatch.setattr('clara_coder_backend.routes.mcp.schedule_mcp_reconcile', lambda: reconciles.append(True))
    try:
        result = await mcp_oauth_tokens(
            McpOAuthTokensUpdateRequest(
                serverId='remote',
                oauth=McpOAuthTokensRequest(
                    accessToken='access-2',
                    expiresAt=time.time() + 3600,
                    clientId='client-1',
                    serverUrl=URL,
                ),
            )
        )
        assert result == {'ok': True}
        assert server.oauth_access_token == 'access-2'
        assert live.auth.context.current_tokens.access_token == 'access-2'
        assert live.fingerprint == _fingerprint(server, '')
        assert reconciles == [True]
    finally:
        mcp_manager._live.pop(server.id, None)
        runtime_config.mcp_servers = previous
