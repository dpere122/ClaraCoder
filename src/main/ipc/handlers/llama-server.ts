import { ipcMain, type WebContents } from 'electron';
import { totalmem } from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../../shared';
import { findLlmModelLocation } from '../../../shared';
import { unwrapSecret } from '../../../shared/types/app-config';
import {
  getManagedChatOpenAiBaseUrl,
  getManagedLlamaConsoles,
  getManagedLlamaLaunchedCommand,
  getManagedLlamaStatus,
  startManagedLlamaServers,
  stopManagedLlamaServers,
  syncWithManagedLlamaOverrides,
} from '../../llama-server-manager';
import { getCachedChatTemplateReasoning, getCachedLlamaServerNctx } from '../../chat-template-reasoning-cache';
import { getLlamaServerFlagCatalog } from '../../llama-server-flag-catalog';
import { readGgufProfile } from '../../utils/gguf-profile';
import { ggufBytesOnDisk } from '../../utils/gguf-size';
import { sampleGpuVramUsage } from '../../utils/gpu-vram-usage';
import { loadConfig } from '../../config/load-save';
import { fetchOpenAiCompatibleModelIds } from '../../openai-compatible-models';
import { findOpenRouterConnection, refreshOpenRouterReasoningForConnection } from '../../openrouter-reasoning';
import { findAnthropicConnection, refreshAnthropicReasoningForConnection } from '../../anthropic-models';
import { findLmStudioConnection, refreshLmStudioReasoningForConnection } from '../../lm-studio-runtime';
import { pingLlmSource } from '../../llm-source-ping';
import { pythonControlFetch } from '../../python/http-client';
import { assertTrustedAppRenderer, assertTrustedMainRendererOrThrow, isTrustedMainRenderer } from '../assert-trusted-renderer';
import { mainState } from '../../state';

export interface LlamaServerIpcPayload {
  modelId: string;
  config: AppConfig;
}

function isSettingsRenderer(sender: WebContents): boolean {
  const win = mainState.settingsWindow;
  return !!win && !win.isDestroyed() && sender === win.webContents;
}

/**
 * The config a start, stop, status or ping acts on. The main window sends its live config. The
 * Settings window (its local server list) always gets the saved one, so what it launches is the
 * command saved in Sources, never a draft from that window.
 */
async function configForSender(sender: WebContents, payload: LlamaServerIpcPayload): Promise<AppConfig> {
  return isTrustedMainRenderer(sender) ? payload.config : loadConfig();
}

/**
 * Start/stop managed llama-server pair and query health from the main process.
 */
function normalizeLlamaModelId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function registerLlamaServerIpc(): void {
  ipcMain.handle('llama-server:start', async (event, payload: LlamaServerIpcPayload) => {
    if (!isTrustedMainRenderer(event.sender) && !isSettingsRenderer(event.sender)) {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload.modelId);
    if (!modelId) {
      return { ok: false as const, error: 'Missing model id.' };
    }
    return startManagedLlamaServers(modelId, await configForSender(event.sender, payload));
  });

  ipcMain.handle('llama-server:stop', async (event, payload: LlamaServerIpcPayload) => {
    if (!isTrustedMainRenderer(event.sender) && !isSettingsRenderer(event.sender)) {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload.modelId);
    if (modelId) {
      await stopManagedLlamaServers(modelId);
    }
    await syncWithManagedLlamaOverrides();
    return { ok: true as const };
  });

  ipcMain.handle('llama-server:status', async (event, payload: LlamaServerIpcPayload) => {
    if (!isTrustedMainRenderer(event.sender) && !isSettingsRenderer(event.sender)) {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload.modelId);
    if (!modelId) {
      return { ok: false as const, error: 'Missing model id.' };
    }
    return getManagedLlamaStatus(modelId, await configForSender(event.sender, payload));
  });

  // Read-only, for the Health window's server list (and any other app window): consoles and states.
  ipcMain.handle('llama-server:consoles', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return [];
    }
    return getManagedLlamaConsoles();
  });

  ipcMain.handle('llm-source:ping', async (event, payload: LlamaServerIpcPayload) => {
    if (!isTrustedMainRenderer(event.sender) && !isSettingsRenderer(event.sender)) {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload.modelId);
    if (!modelId) {
      return { ok: false as const, error: 'No LLM source selected' };
    }
    return pingLlmSource(modelId, await configForSender(event.sender, payload));
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
    // Any active connection asks here; OpenRouter caps come from the model catalog, not a template.
    const config = await loadConfig();
    const openRouter = findOpenRouterConnection(config, modelId);
    if (openRouter) {
      const caps = await refreshOpenRouterReasoningForConnection(openRouter);
      return { ok: true as const, modelId, chatTemplateReasoning: caps ?? null, nCtx: null };
    }
    // Claude caps come from the Models API catalog.
    const anthropic = findAnthropicConnection(config, modelId);
    if (anthropic) {
      const caps = await refreshAnthropicReasoningForConnection(anthropic);
      return { ok: true as const, modelId, chatTemplateReasoning: caps ?? null, nCtx: null };
    }
    // LM Studio reports what each model supports in its model list.
    const lmStudio = findLmStudioConnection(config, modelId);
    if (lmStudio) {
      const caps = await refreshLmStudioReasoningForConnection(lmStudio);
      return { ok: true as const, modelId, chatTemplateReasoning: caps ?? null, nCtx: getCachedLlamaServerNctx(modelId) ?? null };
    }
    return {
      ok: true as const,
      modelId,
      chatTemplateReasoning: getCachedChatTemplateReasoning(modelId) ?? null,
      nCtx: getCachedLlamaServerNctx(modelId) ?? null,
    };
  });

  ipcMain.handle('llama-server:flag-catalog', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    return getLlamaServerFlagCatalog();
  });

  ipcMain.handle('llama-server:vram-usage', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return [];
    }
    return sampleGpuVramUsage();
  });

  ipcMain.handle('llama-server:gguf-size', async (event, payload: { path?: unknown }) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const file = typeof payload?.path === 'string' ? payload.path : '';
    if (!path.isAbsolute(file) || !/\.gguf$/i.test(file)) {
      return null;
    }
    try {
      return await ggufBytesOnDisk(file);
    } catch {
      return null;
    }
  });

  ipcMain.handle('llama-server:gguf-profile', async (event, payload: { path?: unknown }) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const file = typeof payload?.path === 'string' ? payload.path : '';
    if (!path.isAbsolute(file) || !/\.gguf$/i.test(file)) {
      return null;
    }
    return readGgufProfile(file);
  });

  ipcMain.handle('llama-server:total-ram', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    return totalmem();
  });

  ipcMain.handle('llama-server:launched-command', async (event, payload: { modelId?: string }) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    const modelId = normalizeLlamaModelId(payload?.modelId);
    if (!modelId) {
      return { ok: false as const, error: 'Missing model id.' };
    }
    return { ok: true as const, command: getManagedLlamaLaunchedCommand(modelId) };
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
      // Settings is its own window; Connect on the URL source lists models from there.
      assertTrustedAppRenderer(event);
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
