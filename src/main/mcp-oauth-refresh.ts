/**
 * Refreshes MCP OAuth tokens before they expire.
 *
 * Electron is the only refresher. It owns the encrypted tokens, and a second refresher (the
 * Python MCP SDK) would race it and, with rotating refresh tokens, revoke this copy. After a
 * refresh the tokens are saved, broadcast to the windows, and pushed to the Python host, which
 * swaps the access token into the live connection without reconnecting.
 */
import { createHash } from 'crypto';
import type { McpOAuthTokens, McpServerConfig } from '../shared';
import { parseAllowedHttpUrl } from '../shared/safe-http-url';
import { SecretValue, unwrapSecret } from '../shared/types/app-config';
import { loadConfig, updateConfig } from './config/load-save';
import { broadcastToAppWindows } from './ipc/handlers/theme-broadcast';
import { pythonControlFetch } from './python/http-client';
import { wireMcpOAuth } from './python/workspace-sync';

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_SEC = 5 * 60;
/** Retry delay after a network or server error. */
const RETRY_SEC = 60;
/** Re-read config at least this often, so servers saved from Settings are picked up. */
const MAX_WAIT_SEC = 15 * 60;
const FETCH_TIMEOUT_MS = 15_000;

export type McpOAuthRefreshResult =
  | { ok: true; oauth: McpOAuthTokens }
  | { ok: false; error: string; retry: boolean };

function comparableUrl(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}

/** An enabled OAuth server whose tokens were issued for its current URL and can be refreshed. */
export function mcpOAuthRefreshable(server: McpServerConfig): boolean {
  const oauth = server.oauth;
  return (
    server.enabled &&
    server.transport === 'http' &&
    server.httpAuth === 'oauth' &&
    !!oauth &&
    oauth.expiresAt > 0 &&
    !!unwrapSecret(oauth.refreshToken) &&
    !!oauth.tokenEndpoint &&
    !!comparableUrl(oauth.serverUrl) &&
    comparableUrl(oauth.serverUrl) === comparableUrl(server.url)
  );
}

/**
 * One `refresh_token` grant, sent like the MCP SDK's own refresh: `resource` when the sign-in
 * used one, and client credentials per the registered auth method.
 */
export async function refreshMcpOAuthTokens(
  oauth: McpOAuthTokens,
  fetchImpl: typeof fetch = fetch,
  nowSec: number = Date.now() / 1000,
): Promise<McpOAuthRefreshResult> {
  const endpoint = parseAllowedHttpUrl(oauth.tokenEndpoint);
  if (!endpoint) {
    return { ok: false, error: 'Invalid token endpoint.', retry: false };
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: unwrapSecret(oauth.refreshToken),
    client_id: oauth.clientId,
  });
  if (oauth.resource) {
    body.set('resource', oauth.resource);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const secret = unwrapSecret(oauth.clientSecret);
  if (oauth.tokenAuthMethod === 'client_secret_basic' && secret) {
    const pair = `${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(secret)}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
  } else if (oauth.tokenAuthMethod === 'client_secret_post' && secret) {
    body.set('client_secret', secret);
  }

  let res: Response;
  try {
    res = await fetchImpl(endpoint.toString(), {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), retry: true };
  }
  if (!res.ok) {
    // 4xx means the refresh token was rejected (expired, revoked, rotated away): only a new
    // sign-in helps. Server errors and rate limits are worth retrying.
    return { ok: false, error: `Token endpoint returned ${res.status}`, retry: res.status >= 500 || res.status === 429 };
  }
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Token endpoint returned invalid JSON.', retry: true };
  }
  const access = typeof json.access_token === 'string' ? json.access_token : '';
  if (!access) {
    return { ok: false, error: 'Token endpoint returned no access token.', retry: false };
  }
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 0;
  const rotated = typeof json.refresh_token === 'string' ? json.refresh_token : '';
  const scope = typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : null;
  return {
    ok: true,
    oauth: {
      ...oauth,
      accessToken: SecretValue.of(access),
      // Servers that do not rotate keep the current refresh token valid.
      refreshToken: rotated ? SecretValue.of(rotated) : oauth.refreshToken,
      expiresAt: expiresIn ? Math.floor(nowSec + expiresIn) : 0,
      scopes: scope ?? oauth.scopes,
    },
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let rerun = false;
/** Refresh tokens a token endpoint rejected (hashed). Retried only after a new sign-in. */
const rejected = new Set<string>();

function rejectionKey(serverId: string, oauth: McpOAuthTokens): string {
  return createHash('sha256').update(`${serverId}\n${unwrapSecret(oauth.refreshToken)}`).digest('hex');
}

/** Check every OAuth server now (start-up, after sign-in) and schedule the next refresh. */
export function rearmMcpOAuthRefresh(): void {
  if (running) {
    rerun = true;
    return;
  }
  void runDueRefreshes();
}

async function runDueRefreshes(): Promise<void> {
  running = true;
  let nextSec = Date.now() / 1000 + MAX_WAIT_SEC;
  try {
    const config = await loadConfig();
    for (const server of config.mcpServers ?? []) {
      if (!mcpOAuthRefreshable(server) || rejected.has(rejectionKey(server.id, server.oauth!))) {
        continue;
      }
      const nowSec = Date.now() / 1000;
      const dueSec = server.oauth!.expiresAt - REFRESH_MARGIN_SEC;
      if (dueSec > nowSec) {
        nextSec = Math.min(nextSec, dueSec);
      } else if (!(await refreshServer(server))) {
        nextSec = Math.min(nextSec, nowSec + RETRY_SEC);
      }
    }
  } catch (err) {
    console.error('[mcp-oauth] Refresh check failed:', err instanceof Error ? err.message : err);
    nextSec = Math.min(nextSec, Date.now() / 1000 + RETRY_SEC);
  } finally {
    running = false;
  }
  if (rerun) {
    rerun = false;
    void runDueRefreshes();
    return;
  }
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(rearmMcpOAuthRefresh, Math.max(1_000, nextSec * 1000 - Date.now()));
  timer.unref?.();
}

/** Refresh one server's tokens. False when a transient failure should be retried soon. */
async function refreshServer(server: McpServerConfig): Promise<boolean> {
  const used = server.oauth!;
  const result = await refreshMcpOAuthTokens(used);
  if (!result.ok) {
    // Never log tokens; the server name and the status are enough.
    console.warn(`[mcp-oauth] Token refresh failed for "${server.name}": ${result.error}`);
    if (!result.retry) {
      rejected.add(rejectionKey(server.id, used));
    }
    return !result.retry;
  }
  let applied = false;
  const saved = await updateConfig((cfg) => {
    const row = (cfg.mcpServers ?? []).find((entry) => entry.id === server.id);
    // A sign-in that finished while this refresh ran has newer tokens; keep those.
    if (!row?.oauth || unwrapSecret(row.oauth.refreshToken) !== unwrapSecret(used.refreshToken)) {
      return;
    }
    row.oauth = result.oauth;
    applied = true;
  });
  if (!applied) {
    return true;
  }
  broadcastToAppWindows('config-updated', saved);
  const oauth = saved.mcpServers.find((entry) => entry.id === server.id)?.oauth ?? null;
  try {
    const res = await pythonControlFetch('/mcp/oauth/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: server.id, oauth: wireMcpOAuth(oauth) }),
    });
    if (!res.ok) {
      console.warn(`[mcp-oauth] Python did not take the refreshed token for "${server.name}": ${res.status}`);
    }
  } catch {
    // The backend is not up yet; the next runtime sync sends the saved tokens.
  }
  return true;
}
