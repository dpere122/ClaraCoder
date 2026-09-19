import { ipcMain } from 'electron';
import type { AppConfig } from '../../../shared';
import { findLlmModelLocation } from '../../../shared';
import { unwrapSecret } from '../../../shared/types/app-config';
import {
  getManagedChatOpenAiBaseUrl,
  getManagedLlamaStatus,
  startManagedLlamaServers,
  stopManagedLlamaServers,
  syncWithManagedLlamaOverrides,
} from '../../llama-server-manager';
import { getCachedChatTemplateReasoning, getCachedLlamaServerNctx } from '../../chat-template-reasoning-cache';
import { fetchOpenAiCompatibleModelIds } from '../../openai-compatible-models';
import { pythonControlFetch } from '../../python/http-client';
import { assertTrustedMainRendererOrThrow } from '../assert-trusted-renderer';

export interface LlamaServerIpcPayload {
  modelId: string;
  config: AppConfig;
}

/**
 * Start/stop managed llama-server pair and query health from the main process.
 */
function normalizeLlamaModelId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function registerLlamaServerIpc(): void {
  ipcMain.handle('llama-server:start', async (event, payload: LlamaServerIpcPayload) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload.modelId);
    if (!modelId) {
      return { ok: false as const, error: 'Missing model id.' };
    }
    return startManagedLlamaServers(modelId, payload.config);
  });

  ipcMain.handle('llama-server:stop', async (event, payload: LlamaServerIpcPayload) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload.modelId);
    if (modelId) {
      await stopManagedLlamaServers(modelId);
    }
    await syncWithManagedLlamaOverrides(payload.config);
    return { ok: true as const };
  });

  ipcMain.handle('llama-server:status', async (event, payload: LlamaServerIpcPayload) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload.modelId);
    if (!modelId) {
      return { ok: false as const, error: 'Missing model id.' };
    }
    return getManagedLlamaStatus(modelId, payload.config);
  });

  ipcMain.handle('llama-server:chat-template-reasoning', async (event, payload: { modelId?: string }) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload?.modelId);
    if (!modelId) {
      return { ok: false as const, error: 'Missing model id.' };
    }
    return {
      ok: true as const,
      modelId,
      chatTemplateReasoning: getCachedChatTemplateReasoning(modelId) ?? null,
      nCtx: getCachedLlamaServerNctx(modelId) ?? null,
    };
  });

  ipcMain.handle('llamacpp-managed:list-models', async (event, payload: LlamaServerIpcPayload) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload.modelId);
    if (!modelId) {
      return { ok: false as const, error: 'Missing model id.' };
    }
    const loc = findLlmModelLocation(payload.config.llmProviders, modelId);
    if (!loc || loc.provider.provider !== 'llamacpp') {
      return { ok: false as const, error: 'Not a llama.cpp source model.' };
    }
    const base = getManagedChatOpenAiBaseUrl(modelId);
    if (!base) {
      return {
        ok: false as const,
        error: 'Managed llama-server is not running for this source. Start it from the chat sidebar, then refresh.',
      };
    }
    return fetchOpenAiCompatibleModelIds(base, unwrapSecret(loc.provider.apiKey));
  });

  ipcMain.handle('llamacpp-openai:list-models', async (event, payload: { baseUrl: string; apiKey: string }) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const base = typeof payload?.baseUrl === 'string' ? payload.baseUrl : '';
    const key = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
    return fetchOpenAiCompatibleModelIds(base, key);
  });

  ipcMain.handle('embeddings:status', async (event) => {
    try {
      assertTrustedMainRendererOrThrow(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    try {
      const res = await pythonControlFetch('/embeddings/status');
      if (!res.ok) {
        return { ok: false as const, error: `Python returned ${res.status}` };
      }
      const body = (await res.json()) as { status: string; model: string };
      return { ok: true as const, status: body.status, model: body.model };
    } catch (err) {
      return { ok: false as const, error: String(err) };
    }
  });
}
