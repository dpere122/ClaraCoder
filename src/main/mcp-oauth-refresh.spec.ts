import { describe, expect, it, vi } from 'vitest';
import type { McpOAuthTokens, McpServerConfig } from '../shared';
import { createEmptyMcpServer, SecretValue, unwrapSecret } from '../shared';

vi.mock('./config/load-save', () => ({ loadConfig: vi.fn(), updateConfig: vi.fn() }));
vi.mock('./ipc/handlers/theme-broadcast', () => ({ broadcastToAppWindows: vi.fn() }));
vi.mock('./python/http-client', () => ({ pythonControlFetch: vi.fn() }));
vi.mock('./python/workspace-sync', () => ({ wireMcpOAuth: vi.fn() }));

import { mcpOAuthRefreshable, refreshMcpOAuthTokens } from './mcp-oauth-refresh';

function tokens(overrides: Partial<McpOAuthTokens> = {}): McpOAuthTokens {
  return {
    accessToken: SecretValue.of('old-access'),
    refreshToken: SecretValue.of('old-refresh'),
    expiresAt: 1_000,
    clientId: 'client-1',
    clientSecret: SecretValue.of(''),
    scopes: ['read'],
    serverUrl: 'https://mcp.example/mcp',
    tokenEndpoint: 'https://auth.example/oauth/token',
    resource: 'https://mcp.example/mcp',
    tokenAuthMethod: 'none',
    ...overrides,
  };
}

function oauthServer(oauth: McpOAuthTokens | null): McpServerConfig {
  return {
    ...createEmptyMcpServer('srv', 'Remote'),
    transport: 'http',
    url: 'https://mcp.example/mcp/',
    httpAuth: 'oauth',
    oauth,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('refreshMcpOAuthTokens', () => {
  it('sends a refresh grant with the resource and keeps a non-rotated refresh token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 'new-access', expires_in: 3600 }));
    const result = await refreshMcpOAuthTokens(tokens(), fetchImpl as unknown as typeof fetch, 2_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(unwrapSecret(result.oauth.accessToken)).toBe('new-access');
    expect(unwrapSecret(result.oauth.refreshToken)).toBe('old-refresh');
    expect(result.oauth.expiresAt).toBe(5_600);
    expect(result.oauth.serverUrl).toBe('https://mcp.example/mcp');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://auth.example/oauth/token');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('resource')).toBe('https://mcp.example/mcp');
    expect(body.get('client_secret')).toBeNull();
  });

  it('stores a rotated refresh token and sends client credentials per auth method', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 60, scope: 'read write' }),
    );
    const basic = await refreshMcpOAuthTokens(
      tokens({ clientSecret: SecretValue.of('s3cret'), tokenAuthMethod: 'client_secret_basic' }),
      fetchImpl as unknown as typeof fetch,
      0,
    );
    expect(basic.ok && unwrapSecret(basic.oauth.refreshToken)).toBe('r2');
    expect(basic.ok && basic.oauth.scopes).toEqual(['read', 'write']);
    const basicInit = fetchImpl.mock.calls[0]?.[1] as unknown as RequestInit;
    expect((basicInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('client-1:s3cret').toString('base64')}`,
    );

    await refreshMcpOAuthTokens(
      tokens({ clientSecret: SecretValue.of('s3cret'), tokenAuthMethod: 'client_secret_post' }),
      fetchImpl as unknown as typeof fetch,
      0,
    );
    const postInit = fetchImpl.mock.calls[1]?.[1] as unknown as RequestInit;
    expect(new URLSearchParams(String(postInit.body)).get('client_secret')).toBe('s3cret');
  });

  it('gives up on a rejected refresh token and retries server errors', async () => {
    const rejected = await refreshMcpOAuthTokens(tokens(), (async () =>
      jsonResponse(400, { error: 'invalid_grant' })) as unknown as typeof fetch);
    expect(rejected).toMatchObject({ ok: false, retry: false });
    const unavailable = await refreshMcpOAuthTokens(tokens(), (async () =>
      jsonResponse(503, {})) as unknown as typeof fetch);
    expect(unavailable).toMatchObject({ ok: false, retry: true });
    const offline = await refreshMcpOAuthTokens(tokens(), (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch);
    expect(offline).toMatchObject({ ok: false, retry: true });
  });

  it('refuses a non-http token endpoint', async () => {
    const fetchImpl = vi.fn();
    const result = await refreshMcpOAuthTokens(
      tokens({ tokenEndpoint: 'file:///etc/passwd' }),
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('mcpOAuthRefreshable', () => {
  it('refreshes only bound, expiring tokens on an enabled OAuth server', () => {
    expect(mcpOAuthRefreshable(oauthServer(tokens()))).toBe(true);
    expect(mcpOAuthRefreshable(oauthServer(null))).toBe(false);
    expect(mcpOAuthRefreshable(oauthServer(tokens({ serverUrl: 'https://other.example/mcp' })))).toBe(false);
    expect(mcpOAuthRefreshable(oauthServer(tokens({ expiresAt: 0 })))).toBe(false);
    expect(mcpOAuthRefreshable(oauthServer(tokens({ tokenEndpoint: '' })))).toBe(false);
    expect(mcpOAuthRefreshable(oauthServer(tokens({ refreshToken: SecretValue.of('') })))).toBe(false);
    expect(mcpOAuthRefreshable({ ...oauthServer(tokens()), enabled: false })).toBe(false);
  });
});
