/** MCP host status, OAuth sign-in, and remembered tool decisions. */
import { ipcMain, type BrowserWindow } from 'electron';
import type { AppConfig, McpHostStatus, McpOAuthTokens, McpRememberDecision } from '../../../shared';
import { SecretValue } from '../../../shared/types/app-config';
import { updateConfig } from '../../config/load-save';
import { getLlamaManagedRuntimeOverrides } from '../../llama-server-manager';
import { pythonControlFetch, pythonLongFetch } from '../../python/http-client';
import { syncRuntimeConfigToPython } from '../../python/workspace-sync';
import { mainState } from '../../state';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

function sendIfAlive(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    win.webContents.send(channel, payload);
  } catch {
    // Window can close between the check and the send.
  }
}

function broadcastConfig(config: AppConfig): void {
  sendIfAlive(mainState.mainWindow, 'config-updated', config);
  sendIfAlive(mainState.settingsWindow, 'config-updated', config);
  sendIfAlive(mainState.healthWindow, 'config-updated', config);
  sendIfAlive(mainState.dependenciesWindow, 'config-updated', config);
}

function oauthFromWire(raw: unknown): McpOAuthTokens | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const accessToken = typeof row.accessToken === 'string' ? row.accessToken : '';
  if (!accessToken) {
    return null;
  }
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === 'string') : [];
  return {
    accessToken: SecretValue.of(accessToken),
    refreshToken: SecretValue.of(typeof row.refreshToken === 'string' ? row.refreshToken : ''),
    expiresAt: typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt) ? row.expiresAt : 0,
    clientId: typeof row.clientId === 'string' ? row.clientId : '',
    clientSecret: SecretValue.of(typeof row.clientSecret === 'string' ? row.clientSecret : ''),
    scopes,
    serverUrl: typeof row.serverUrl === 'string' ? row.serverUrl.trim() : '',
  };
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:status', async (event): Promise<{ ok: true; status: McpHostStatus } | { ok: false; error: string }> => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    try {
      const res = await pythonControlFetch('/mcp/status');
      if (!res.ok) {
        return { ok: false, error: `Python returned ${res.status}` };
      }
      const status = (await res.json()) as McpHostStatus;
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'mcp:oauth-start',
    async (event, serverId: unknown): Promise<{ ok: true; config: AppConfig } | { ok: false; error: string }> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const id = typeof serverId === 'string' ? serverId.trim() : '';
      if (!id) {
        return { ok: false, error: 'MCP server id is required.' };
      }
      const { loadConfig } = await import('../../config/load-save');
      const current = await loadConfig();
      const server = (current.mcpServers ?? []).find((entry) => entry.id === id);
      if (!server) {
        return { ok: false, error: 'Save the MCP server before signing in.' };
      }
      try {
        const res = await pythonLongFetch('/mcp/oauth/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            server: {
              id: server.id,
              name: server.name,
              enabled: true,
              trust: server.trust,
              transport: 'http',
              url: server.url,
              httpTransport: server.httpTransport,
              httpAuth: 'oauth',
              headers: (server.headers ?? []).map((entry) => ({
                key: entry.key,
                value: typeof entry.value === 'string' ? entry.value : entry.value.unwrap(),
              })),
              oauth: server.oauth
                ? {
                    accessToken: typeof server.oauth.accessToken === 'string' ? server.oauth.accessToken : server.oauth.accessToken.unwrap(),
                    refreshToken:
                      typeof server.oauth.refreshToken === 'string' ? server.oauth.refreshToken : server.oauth.refreshToken.unwrap(),
                    expiresAt: server.oauth.expiresAt,
                    clientId: server.oauth.clientId,
                    clientSecret:
                      typeof server.oauth.clientSecret === 'string' ? server.oauth.clientSecret : server.oauth.clientSecret.unwrap(),
                    scopes: server.oauth.scopes ?? [],
                    serverUrl: server.oauth.serverUrl ?? '',
                  }
                : null,
              toolDecisions: server.toolDecisions ?? {},
            },
          }),
        });
        const body = (await res.json()) as { oauth?: unknown; detail?: unknown };
        if (!res.ok) {
          const detail = typeof body.detail === 'string' ? body.detail : `Python returned ${res.status}`;
          return { ok: false, error: detail };
        }
        const oauth = oauthFromWire(body.oauth);
        if (!oauth) {
          return { ok: false, error: 'Sign-in finished without an access token.' };
        }
        const saved = await updateConfig((cfg) => {
          const target = (cfg.mcpServers ?? []).find((entry) => entry.id === id);
          if (!target) {
            throw new Error('MCP server disappeared before the token could be stored.');
          }
          target.httpAuth = 'oauth';
          target.oauth = oauth;
        });
        broadcastConfig(saved);
        await syncRuntimeConfigToPython(saved, () => getLlamaManagedRuntimeOverrides(saved));
        return { ok: true, config: saved };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'mcp:remember-decision',
    async (event, payload: McpRememberDecision): Promise<{ ok: true; config: AppConfig } | { ok: false; error: string }> => {
      try {
        assertTrustedAppRenderer(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const serverId = typeof payload?.serverId === 'string' ? payload.serverId.trim() : '';
      const decision = payload?.decision;
      const toolName = typeof payload?.toolName === 'string' ? payload.toolName.trim() : '';
      if (!serverId || (decision !== 'allow' && decision !== 'deny' && decision !== 'allow-all')) {
        return { ok: false, error: 'A server id and decision are required.' };
      }
      if (decision !== 'allow-all' && !toolName) {
        return { ok: false, error: 'A tool name is required.' };
      }
      try {
        const saved = await updateConfig((cfg) => {
          const target = (cfg.mcpServers ?? []).find((entry) => entry.id === serverId);
          if (!target) {
            throw new Error('MCP server not found.');
          }
          if (decision === 'allow-all') {
            target.trust = 'allow-all';
            return;
          }
          target.toolDecisions = { ...(target.toolDecisions ?? {}), [toolName]: decision };
        });
        broadcastConfig(saved);
        await syncRuntimeConfigToPython(saved, () => getLlamaManagedRuntimeOverrides(saved));
        return { ok: true, config: saved };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
