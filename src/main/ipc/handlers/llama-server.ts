import { ipcMain } from 'electron';
import type { AppConfig } from '../../../shared';
import {
  getManagedLlamaStatus,
  startManagedLlamaServers,
  stopManagedLlamaServers,
  syncWithManagedLlamaOverrides,
} from '../../llama-server-manager';

export interface LlamaServerIpcPayload {
  modelId: string;
  config: AppConfig;
}

/**
 * Start/stop managed llama-server pair and query health from the main process.
 */
export function registerLlamaServerIpc(): void {
  ipcMain.handle('llama-server:start', async (_event, payload: LlamaServerIpcPayload) => {
    return startManagedLlamaServers(payload.modelId, payload.config);
  });

  ipcMain.handle('llama-server:stop', async (_event, payload: LlamaServerIpcPayload) => {
    stopManagedLlamaServers(payload.modelId);
    await syncWithManagedLlamaOverrides(payload.config);
    return { ok: true as const };
  });

  ipcMain.handle('llama-server:status', async (_event, payload: LlamaServerIpcPayload) => {
    return getManagedLlamaStatus(payload.modelId, payload.config);
  });
}
