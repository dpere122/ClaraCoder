"""MCP host status and interactive OAuth."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from clara_coder_backend.domain import RuntimeMcpServer
from clara_coder_backend.mcp.manager import mcp_manager
from clara_coder_backend.session.schemas import McpOAuthStartRequest

router = APIRouter(prefix='/mcp', tags=['mcp'])


def _server_from_request(item: McpOAuthStartRequest) -> RuntimeMcpServer:
    server = item.server
    oauth = server.oauth
    return RuntimeMcpServer(
        id=server.id.strip(),
        name=(server.name or '').strip(),
        enabled=True,
        trust=server.trust,
        transport='http',
        url=(server.url or '').strip(),
        http_transport=server.httpTransport,
        http_auth='oauth',
        headers=[(entry.key, entry.value) for entry in server.headers if entry.key.strip()],
        oauth_access_token=(oauth.accessToken if oauth else '') or '',
        oauth_refresh_token=(oauth.refreshToken if oauth else '') or '',
        oauth_expires_at=float(oauth.expiresAt) if oauth else 0,
        oauth_client_id=(oauth.clientId if oauth else '') or '',
        oauth_client_secret=(oauth.clientSecret if oauth else '') or '',
        oauth_scopes=list(oauth.scopes) if oauth else [],
        oauth_server_url=((oauth.serverUrl if oauth else '') or '').strip(),
    )


@router.get('/status')
async def mcp_status() -> dict[str, object]:
    return mcp_manager.status()


@router.post('/oauth/start')
async def mcp_oauth_start(request: McpOAuthStartRequest) -> dict[str, object]:
    """Block on the system browser until the loopback redirect returns tokens."""

    server = _server_from_request(request)
    if not server.id:
        raise HTTPException(status_code=400, detail='MCP server id is required.')
    try:
        stored = await mcp_manager.oauth_start(server)
    except Exception as exc:
        message = str(exc).strip() or exc.__class__.__name__
        raise HTTPException(status_code=400, detail=message) from exc
    return {'ok': True, 'oauth': stored.as_public_dict()}
