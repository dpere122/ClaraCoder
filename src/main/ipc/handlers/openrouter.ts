import { ipcMain } from 'electron';
import { fetchOpenRouterCatalog } from '../../openrouter-models';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

/** Settings lists OpenRouter models from its own window. */
export function registerOpenRouterIpc(): void {
  ipcMain.handle('openrouter:list-models', async (event, payload: { baseUrl: string; apiKey: string }) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const base = typeof payload?.baseUrl === 'string' ? payload.baseUrl : '';
    const key = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
    return fetchOpenRouterCatalog(base, key);
  });
}
