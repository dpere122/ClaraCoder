"""Long-lived MCP client sessions for the configured server list."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from clara_coder_backend.domain import RuntimeMcpServer
from clara_coder_backend.mcp.oauth import (
    OAuthLoopback,
    StoredOAuth,
    build_oauth_provider,
    has_usable_oauth_token,
    stored_from_memory,
)

logger = logging.getLogger('clara.mcp')

SCHEMA_WARN_PER_SERVER = 6_000
SCHEMA_WARN_TOTAL = 12_000
_CONNECT_TIMEOUT_SEC = 20.0
_CALL_TIMEOUT_SEC = 60.0


@dataclass
class LiveServer:
    fingerprint: str
    connected: bool = False
    error: str = ''
    needs_sign_in: bool = False
    schema_tokens: int = 0
    tools: list[Any] = field(default_factory=list)
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None
    session: Any = None


def _schema_tokens(tools: list[Any]) -> int:
    try:
        import tiktoken

        enc = tiktoken.get_encoding('cl100k_base')
    except Exception:
        enc = None
    total = 0
    for tool in tools:
        payload = json.dumps(
            {
                'name': getattr(tool, 'name', ''),
                'description': getattr(tool, 'description', '') or '',
                'inputSchema': getattr(tool, 'inputSchema', None) or {},
            },
            ensure_ascii=False,
        )
        if enc is not None:
            total += len(enc.encode(payload))
        else:
            total += max(1, len(payload) // 4)
    return total


def _fingerprint(server: RuntimeMcpServer, workspace: str) -> str:
    token = hashlib.sha256((server.oauth_access_token or '').encode('utf-8')).hexdigest()[:16]
    payload = {
        'id': server.id,
        'transport': server.transport,
        'command': server.command,
        'args': server.args,
        'env': server.env,
        'url': server.url,
        'http_transport': server.http_transport,
        'http_auth': server.http_auth,
        'headers': server.headers,
        'oauth': token,
        'client': server.oauth_client_id,
        'workspace': workspace,
    }
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _valid_http_url(url: str) -> bool:
    text = (url or '').strip()
    return text.startswith('http://') or text.startswith('https://')


def _format_tool_result(result: Any) -> str:
    parts: list[str] = []
    for block in getattr(result, 'content', None) or []:
        kind = str(getattr(block, 'type', '') or '')
        if kind == 'text':
            parts.append(str(getattr(block, 'text', '') or ''))
        elif kind == 'image':
            mime = str(getattr(block, 'mimeType', '') or 'image')
            parts.append(f'[image {mime}]')
        else:
            text = getattr(block, 'text', None)
            parts.append(str(text) if text else f'[{kind or "content"}]')
    text = '\n'.join(part for part in parts if part).strip()
    structured = getattr(result, 'structuredContent', None)
    if not text and structured is not None:
        raw = json.dumps(structured, ensure_ascii=False)
        if len(raw) > 20_000:
            raw = raw[:20_000] + '... [truncated]'
        text = raw
    if getattr(result, 'isError', False):
        return text or 'MCP tool returned an error.'
    return text or '(empty)'


def _env_overlay(server: RuntimeMcpServer) -> dict[str, str] | None:
    """The server's own env entries only.

    The SDK layers these over its allowlisted default environment (PATH, HOME, ...). Never
    merge ``os.environ``: it holds the sidecar bearer token and the user's API keys.
    """

    overlay = {key: value for key, value in server.env if key.strip()}
    return overlay or None


def _header_map(server: RuntimeMcpServer) -> dict[str, str] | None:
    """Static headers, sent only while Auth is "Static headers" (Settings hides them otherwise)."""

    if server.http_auth != 'headers':
        return None
    headers = {key: value for key, value in server.headers if key.strip()}
    return headers or None


class McpManager:
    """Reconcile enabled servers and call their tools."""

    def __init__(self) -> None:
        self._live: dict[str, LiveServer] = {}
        self._lock = asyncio.Lock()
        self._workspace = ''

    def status(self) -> dict[str, Any]:
        from clara_coder_backend.session.state import runtime_config

        rows: list[dict[str, Any]] = []
        total = 0
        by_id = {server.id: server for server in runtime_config.mcp_servers}
        for server_id, server in by_id.items():
            live = self._live.get(server_id)
            tokens = live.schema_tokens if live else 0
            total += tokens
            tools = []
            if live:
                for tool in live.tools:
                    tools.append(
                        {
                            'name': str(getattr(tool, 'name', '') or ''),
                            'description': str(getattr(tool, 'description', '') or ''),
                        }
                    )
            rows.append(
                {
                    'id': server_id,
                    'connected': bool(live and live.connected),
                    'error': '' if not live else live.error,
                    'needsSignIn': bool(live and live.needs_sign_in) or (
                        server.enabled
                        and server.transport == 'http'
                        and server.http_auth == 'oauth'
                        and not has_usable_oauth_token(server)
                        and not (live and live.connected)
                    ),
                    'toolCount': len(tools),
                    'schemaTokens': tokens,
                    'schemaWarning': tokens >= SCHEMA_WARN_PER_SERVER,
                    'tools': tools,
                }
            )
        return {
            'servers': rows,
            'schemaTokens': total,
            'schemaWarning': total >= SCHEMA_WARN_TOTAL,
        }

    def listed_tools(self) -> list[tuple[RuntimeMcpServer, Any]]:
        from clara_coder_backend.session.state import runtime_config

        pairs: list[tuple[RuntimeMcpServer, Any]] = []
        for server in runtime_config.mcp_servers:
            if not server.enabled:
                continue
            live = self._live.get(server.id)
            if not live or not live.connected:
                continue
            for tool in live.tools:
                pairs.append((server, tool))
        return pairs

    async def reconcile(self) -> None:
        from clara_coder_backend.session.state import runtime_config

        async with self._lock:
            workspace = (runtime_config.active_workspace_path or '').strip()
            self._workspace = workspace
            enabled = [server for server in runtime_config.mcp_servers if server.enabled]
            wanted = {server.id: _fingerprint(server, workspace) for server in enabled}
            for server_id in list(self._live):
                if self._live[server_id].fingerprint != wanted.get(server_id):
                    await self._stop_locked(server_id)
            for server in enabled:
                fingerprint = wanted[server.id]
                existing = self._live.get(server.id)
                if existing is not None:
                    still_starting = not existing.ready.is_set()
                    if existing.connected or still_starting or (existing.needs_sign_in and existing.task is None):
                        continue
                    if not existing.error:
                        continue
                    await self._stop_locked(server.id)
                if server.transport == 'stdio' and not server.command.strip():
                    self._remember_idle(server.id, fingerprint, error='Command is required')
                    continue
                if server.transport == 'http' and not _valid_http_url(server.url):
                    self._remember_idle(server.id, fingerprint, error='An http or https URL is required')
                    continue
                if (
                    server.transport == 'http'
                    and server.http_auth == 'oauth'
                    and not has_usable_oauth_token(server)
                ):
                    self._remember_idle(server.id, fingerprint, needs_sign_in=True, error='Sign in required')
                    continue
                live = LiveServer(fingerprint=fingerprint)
                live.task = asyncio.create_task(self._run(server, live, workspace))
                self._live[server.id] = live

    async def wait_until_settled(self, timeout: float = _CONNECT_TIMEOUT_SEC) -> None:
        lives = list(self._live.values())
        if not lives:
            return
        await asyncio.wait_for(asyncio.gather(*(live.ready.wait() for live in lives)), timeout)

    async def call_tool(self, server_id: str, tool_name: str, arguments: dict[str, Any] | None) -> str:
        live = self._live.get(server_id)
        if live is None or live.session is None:
            detail = live.error if live and live.error else 'MCP server is not connected.'
            return detail
        try:
            result = await asyncio.wait_for(
                live.session.call_tool(tool_name, arguments or {}),
                _CALL_TIMEOUT_SEC,
            )
        except Exception as exc:
            logger.info('mcp tool call failed server=%s tool=%s', server_id, tool_name)
            return f'MCP tool `{tool_name}` failed: {exc}'
        return _format_tool_result(result)

    async def oauth_start(self, server: RuntimeMcpServer) -> StoredOAuth:
        """Interactive sign-in. Returns tokens; the caller persists them and reconciles."""

        if server.transport != 'http' or not _valid_http_url(server.url):
            raise RuntimeError('OAuth sign-in needs an http or https MCP server.')
        loopback = OAuthLoopback()
        redirect = await loopback.start()
        provider, storage = build_oauth_provider(
            server,
            redirect_uri=redirect,
            interactive=True,
            loopback=loopback,
        )
        try:
            await self._probe(server, auth=provider, workspace=self._workspace)
        finally:
            await loopback.close()
        stored = stored_from_memory(storage, server_url=server.url)
        if not stored.access_token:
            raise RuntimeError('Sign-in finished without an access token.')
        return stored

    async def shutdown(self) -> None:
        async with self._lock:
            for server_id in list(self._live):
                await self._stop_locked(server_id)

    def _remember_idle(
        self,
        server_id: str,
        fingerprint: str,
        *,
        error: str = '',
        needs_sign_in: bool = False,
    ) -> None:
        live = LiveServer(fingerprint=fingerprint, error=error, needs_sign_in=needs_sign_in)
        live.ready.set()
        self._live[server_id] = live

    async def _stop_locked(self, server_id: str) -> None:
        live = self._live.pop(server_id, None)
        if live is None:
            return
        live.stop.set()
        if live.task is not None and not live.task.done():
            try:
                await asyncio.wait_for(live.task, 5)
            except Exception:
                live.task.cancel()

    async def _run(self, server: RuntimeMcpServer, live: LiveServer, workspace: str) -> None:
        try:
            await self._connect(server, live, workspace)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if live.stop.is_set():
                return
            message = str(exc).strip() or exc.__class__.__name__
            if 'sign-in' in message.lower() or 'unauthorized' in message.lower() or '401' in message:
                live.needs_sign_in = True
            live.error = message
            logger.info('mcp server %s failed: %s', server.id, message)
        finally:
            live.session = None
            live.connected = False
            live.ready.set()

    async def _connect(self, server: RuntimeMcpServer, live: LiveServer, workspace: str) -> None:
        from mcp import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client
        from mcp.types import ListRootsResult, Root

        async def _roots(_ctx: Any) -> Any:
            path = (self._workspace or workspace or '').strip()
            if not path:
                return ListRootsResult(roots=[])
            return ListRootsResult(roots=[Root(uri=Path(path).resolve().as_uri(), name='workspace')])

        if server.transport == 'stdio':
            params = StdioServerParameters(
                command=server.command.strip(),
                args=list(server.args),
                env=_env_overlay(server),
                cwd=workspace or None,
            )
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write, list_roots_callback=_roots) as session:
                    await self._adopt(session, live)
                    await live.stop.wait()
            return

        auth = None
        if server.http_auth == 'oauth':
            auth, _storage = build_oauth_provider(
                server,
                redirect_uri='http://127.0.0.1/callback',
                interactive=False,
                loopback=None,
            )
        headers = _header_map(server)
        if server.http_transport == 'sse':
            from mcp.client.sse import sse_client

            async with sse_client(server.url.strip(), headers=headers, auth=auth) as (read, write):
                async with ClientSession(read, write, list_roots_callback=_roots) as session:
                    await self._adopt(session, live)
                    await live.stop.wait()
            return
        from mcp.client.streamable_http import streamablehttp_client

        async with streamablehttp_client(server.url.strip(), headers=headers, auth=auth) as (read, write, _sid):
            async with ClientSession(read, write, list_roots_callback=_roots) as session:
                await self._adopt(session, live)
                await live.stop.wait()

    async def _probe(self, server: RuntimeMcpServer, *, auth: Any, workspace: str) -> None:
        from mcp import ClientSession

        headers = _header_map(server)
        if server.http_transport == 'sse':
            from mcp.client.sse import sse_client

            async with sse_client(server.url.strip(), headers=headers, auth=auth) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
            return
        from mcp.client.streamable_http import streamablehttp_client

        async with streamablehttp_client(server.url.strip(), headers=headers, auth=auth) as (read, write, _sid):
            async with ClientSession(read, write) as session:
                await session.initialize()

    async def _adopt(self, session: Any, live: LiveServer) -> None:
        await asyncio.wait_for(session.initialize(), _CONNECT_TIMEOUT_SEC)
        tools: list[Any] = []
        cursor: str | None = None
        while True:
            page = await asyncio.wait_for(session.list_tools(cursor=cursor), _CONNECT_TIMEOUT_SEC)
            tools.extend(list(page.tools or []))
            cursor = page.nextCursor
            if not cursor:
                break
        live.session = session
        live.tools = tools
        live.schema_tokens = _schema_tokens(tools)
        live.connected = True
        live.error = ''
        live.ready.set()


mcp_manager = McpManager()


def schedule_mcp_reconcile() -> None:
    """Start a reconcile on the running loop. Safe to call from the runtime-config handler."""

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_reconcile_quietly())


async def _reconcile_quietly() -> None:
    try:
        await mcp_manager.reconcile()
    except Exception:
        logger.exception('mcp reconcile failed')


async def shutdown_mcp() -> None:
    await mcp_manager.shutdown()
