import { ipcMain } from 'electron';
import type { AppConfig } from '../../../shared';
import { findLlmModelLocation } from '../../../shared';
import {
  getManagedChatOpenAiBaseUrl,
  getManagedLlamaStatus,
  startManagedLlamaServers,
  stopManagedLlamaServers,
  syncWithManagedLlamaOverrides,
} from '../../llama-server-manager';
import { fetchOpenAiCompatibleModelIds } from '../../openai-compatible-models';

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

  ipcMain.handle('llamacpp-managed:list-models', async (_event, payload: LlamaServerIpcPayload) => {
    const loc = findLlmModelLocation(payload.config.llmProviders, payload.modelId);
    if (!loc || loc.provider.provider !== 'llamacpp') {
      return { ok: false as const, error: 'Not a llama.cpp source model.' };
    }
    const base = getManagedChatOpenAiBaseUrl(payload.modelId);
    if (!base) {
      return {
        ok: false as const,
        error: 'Managed llama-server is not running for this source. Start it from the chat sidebar, then refresh.',
      };
    }
    return fetchOpenAiCompatibleModelIds(base, loc.provider.apiKey);
  });

  ipcMain.handle('llamacpp-openai:list-models', async (_event, payload: { baseUrl: string; apiKey: string }) => {
    const base = typeof payload?.baseUrl === 'string' ? payload.baseUrl : '';
    const key = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
    return fetchOpenAiCompatibleModelIds(base, key);
  });
}
