"""MCP OAuth: loopback redirect, system browser, and stored tokens."""

from __future__ import annotations

import asyncio
import logging
import time
import urllib.parse
import webbrowser
from dataclasses import dataclass

from pydantic import AnyUrl

from clara_coder_backend.domain import RuntimeMcpServer

logger = logging.getLogger('clara.mcp')

_OAUTH_TIMEOUT_SEC = 180.0


@dataclass
class StoredOAuth:
    access_token: str = ''
    refresh_token: str = ''
    expires_at: float = 0
    client_id: str = ''
    client_secret: str = ''
    scopes: list[str] | None = None

    def as_public_dict(self) -> dict[str, object]:
        return {
            'accessToken': self.access_token,
            'refreshToken': self.refresh_token,
            'expiresAt': self.expires_at,
            'clientId': self.client_id,
            'clientSecret': self.client_secret,
            'scopes': list(self.scopes or []),
        }


class OAuthLoopback:
    """Local HTTP listener for the authorization-code redirect."""

    def __init__(self) -> None:
        self.redirect_uri = ''
        self._future: asyncio.Future[tuple[str, str | None]] | None = None
        self._server: asyncio.Server | None = None

    async def start(self) -> str:
        loop = asyncio.get_running_loop()
        self._future = loop.create_future()
        self._server = await asyncio.start_server(self._on_conn, '127.0.0.1', 0)
        sockets = self._server.sockets or []
        port = sockets[0].getsockname()[1]
        self.redirect_uri = f'http://127.0.0.1:{port}/callback'
        return self.redirect_uri

    async def wait(self) -> tuple[str, str | None]:
        if self._future is None:
            raise RuntimeError('OAuth listener is not started.')
        return await asyncio.wait_for(self._future, _OAUTH_TIMEOUT_SEC)

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def _on_conn(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await reader.read(65536)
            text = raw.decode('latin1', errors='replace')
            first = text.split('\r\n', 1)[0]
            path = first.split(' ')[1] if len(first.split(' ')) > 1 else ''
            parsed = urllib.parse.urlparse(path)
            query = urllib.parse.parse_qs(parsed.query)
            code = (query.get('code') or [''])[0]
            state = (query.get('state') or [None])[0]
            error = (query.get('error') or [''])[0]
            body = b'You can close this window and return to Clara Coder.'
            if error:
                body = f'Sign-in failed: {error}'.encode('utf-8', errors='replace')
            header = (
                b'HTTP/1.1 200 OK\r\n'
                b'Content-Type: text/plain; charset=utf-8\r\n'
                b'Connection: close\r\n'
                b'Content-Length: ' + str(len(body)).encode('ascii') + b'\r\n\r\n'
            )
            writer.write(header + body)
            await writer.drain()
            if self._future is not None and not self._future.done():
                if error:
                    self._future.set_exception(RuntimeError(error))
                else:
                    self._future.set_result((code, state))
        except Exception:
            logger.debug('oauth loopback read failed', exc_info=True)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


class MemoryTokenStorage:
    """In-memory TokenStorage for one OAuth attempt or one live session."""

    def __init__(self, tokens: object | None = None, client_info: object | None = None) -> None:
        self.tokens = tokens
        self.client_info = client_info

    async def get_tokens(self) -> object | None:
        return self.tokens

    async def set_tokens(self, tokens: object) -> None:
        self.tokens = tokens

    async def get_client_info(self) -> object | None:
        return self.client_info

    async def set_client_info(self, client_info: object) -> None:
        self.client_info = client_info


def _token_from_server(server: RuntimeMcpServer) -> object | None:
    from mcp.shared.auth import OAuthToken

    access = (server.oauth_access_token or '').strip()
    if not access:
        return None
    expires_in = None
    if server.oauth_expires_at:
        expires_in = max(0, int(server.oauth_expires_at - time.time()))
    refresh = (server.oauth_refresh_token or '').strip() or None
    scope = ' '.join(server.oauth_scopes) if server.oauth_scopes else None
    return OAuthToken(
        access_token=access,
        token_type='Bearer',
        refresh_token=refresh,
        expires_in=expires_in,
        scope=scope,
    )


def _client_info_from_server(server: RuntimeMcpServer, redirect_uri: str) -> object | None:
    from mcp.shared.auth import OAuthClientInformationFull

    client_id = (server.oauth_client_id or '').strip()
    if not client_id:
        return None
    secret = (server.oauth_client_secret or '').strip() or None
    return OAuthClientInformationFull(
        client_id=client_id,
        client_secret=secret,
        redirect_uris=[AnyUrl(redirect_uri)],
        grant_types=['authorization_code', 'refresh_token'],
        response_types=['code'],
        token_endpoint_auth_method='client_secret_post' if secret else 'none',
    )


def stored_from_memory(storage: MemoryTokenStorage) -> StoredOAuth:
    tokens = storage.tokens
    info = storage.client_info
    access = str(getattr(tokens, 'access_token', '') or '')
    refresh = str(getattr(tokens, 'refresh_token', '') or '')
    expires_in = getattr(tokens, 'expires_in', None)
    expires_at = time.time() + int(expires_in) if isinstance(expires_in, int) and expires_in > 0 else 0
    scope = str(getattr(tokens, 'scope', '') or '')
    scopes = [part for part in scope.split() if part] if scope else []
    return StoredOAuth(
        access_token=access,
        refresh_token=refresh,
        expires_at=expires_at,
        client_id=str(getattr(info, 'client_id', '') or ''),
        client_secret=str(getattr(info, 'client_secret', '') or ''),
        scopes=scopes,
    )


def build_oauth_provider(
    server: RuntimeMcpServer,
    *,
    redirect_uri: str,
    interactive: bool,
    loopback: OAuthLoopback | None,
) -> tuple[object, MemoryTokenStorage]:
    """Build the SDK auth handler. Interactive sign-in opens the system browser."""

    from mcp.client.auth import OAuthClientProvider
    from mcp.shared.auth import OAuthClientMetadata

    storage = MemoryTokenStorage(
        tokens=_token_from_server(server),
        client_info=_client_info_from_server(server, redirect_uri),
    )
    secret = (server.oauth_client_secret or '').strip()
    metadata = OAuthClientMetadata(
        redirect_uris=[AnyUrl(redirect_uri)],
        grant_types=['authorization_code', 'refresh_token'],
        response_types=['code'],
        client_name='Clara Coder',
        token_endpoint_auth_method='client_secret_post' if secret else 'none',
    )

    async def _open_browser(url: str) -> None:
        if not interactive:
            raise RuntimeError('MCP server requires sign-in')
        webbrowser.open(url)

    async def _callback() -> tuple[str, str | None]:
        if loopback is None:
            raise RuntimeError('MCP server requires sign-in')
        return await loopback.wait()

    provider = OAuthClientProvider(
        server_url=server.url,
        client_metadata=metadata,
        storage=storage,
        redirect_handler=_open_browser,
        callback_handler=_callback,
        timeout=_OAUTH_TIMEOUT_SEC,
    )
    return provider, storage
