/**
 * What LM Studio reports about the active model, and loading it before a chat turn. A request for
 * an unloaded model makes LM Studio auto-load it with its own settings, so Clara loads it first
 * with the ones from Settings unless the user turned that off.
 */
import type { AppConfig, ChatTemplateReasoningCaps, LlmConnectionConfig } from '../shared';
import { flattenLlmProvidersToConnections, resolveActiveLlmConnection } from '../shared';
import {
  effectiveLmStudioContextTokens,
  lmStudioLoadOptions,
  lmStudioReasoningCaps,
  normalizeLmStudioSettings,
} from '../shared/lm-studio-ipc';
import { lmStudioOpenAiBaseUrlToRestOrigin } from '../shared/lm-studio-url';
import { unwrapSecret } from '../shared/types/app-config';
import {
  clearCachedChatTemplateReasoning,
  setCachedChatTemplateReasoning,
  setCachedLlamaServerNctx,
} from './chat-template-reasoning-cache';
import { loadConfig } from './config/load-save';
import { lmStudioListModels, lmStudioLoadModel } from './lm-studio-client';
import { getLlamaManagedRuntimeOverrides } from './llama-server-manager';
import { syncRuntimeConfigToPython } from './python/workspace-sync';

/** The LM Studio connection with this id, or null for other providers / unknown ids. */
export function findLmStudioConnection(config: AppConfig, connectionId: string): LlmConnectionConfig | null {
  const connection = flattenLlmProvidersToConnections(config.llmProviders).find((c) => c.id === connectionId);
  return connection?.provider === 'lmstudio' ? connection : null;
}

/**
 * Recomputes and caches caps for one LM Studio connection. ``undefined`` (cache cleared) when the
 * server is unreachable, does not list the model or can't report caps, so the UI keeps its generic controls.
 */
export async function refreshLmStudioReasoningForConnection(
  connection: LlmConnectionConfig,
): Promise<ChatTemplateReasoningCaps | undefined> {
  const list = await lmStudioListModels(connection.baseUrl, unwrapSecret(connection.apiKey));
  const card = list.ok ? list.models.find((c) => c.id === connection.model.trim()) : undefined;
  if (!list.ok || !card) {
    clearCachedChatTemplateReasoning(connection.id);
    return undefined;
  }
  const n = effectiveLmStudioContextTokens(card);
  if (n > 0) {
    setCachedLlamaServerNctx(connection.id, n);
  }
  // Only v1 reports capabilities: an older server saying nothing doesn't mean the model can't think.
  if (list.source !== 'v1') {
    clearCachedChatTemplateReasoning(connection.id);
    return undefined;
  }
  const caps = lmStudioReasoningCaps(card);
  setCachedChatTemplateReasoning(connection.id, caps);
  return caps;
}

/**
 * Load the connection's model if it isn't loaded. True when this call loaded it. Never throws: if
 * this fails the turn still goes out, and LM Studio's own auto-load or error takes over.
 */
export async function ensureLmStudioModelLoaded(connection: LlmConnectionConfig): Promise<boolean> {
  const settings = normalizeLmStudioSettings(connection.lmStudio);
  const model = connection.model.trim();
  const origin = lmStudioOpenAiBaseUrlToRestOrigin(connection.baseUrl);
  if (connection.provider !== 'lmstudio' || !settings.autoLoad || !model || !origin) {
    return false;
  }
  const apiKey = unwrapSecret(connection.apiKey);
  const list = await lmStudioListModels(connection.baseUrl, apiKey);
  // Only v1 has a load endpoint; an older server auto-loads on its own.
  if (!list.ok || list.source !== 'v1') {
    return false;
  }
  const card = list.models.find((c) => c.id === model);
  if (!card || card.state === 'loaded' || card.state === 'loading') {
    return false;
  }
  const result = await lmStudioLoadModel(origin, model, apiKey, lmStudioLoadOptions(settings, card.max_context_length));
  if (!result.ok) {
    console.warn('[LM Studio] Could not load the model before the turn:', result.error);
    return false;
  }
  return true;
}

const loadsInFlight = new Map<string, Promise<boolean>>();

/** Before a turn: load the active model if it needs it, and tell Python its real context size. */
export async function ensureActiveLmStudioModelLoaded(): Promise<void> {
  try {
    const config = await loadConfig();
    const connection = resolveActiveLlmConnection(config);
    if (connection?.provider !== 'lmstudio') {
      return;
    }
    // Two conversations starting at once must not load the model twice.
    const key = `${connection.baseUrl}|${connection.model}`;
    let load = loadsInFlight.get(key);
    if (!load) {
      load = ensureLmStudioModelLoaded(connection).finally(() => loadsInFlight.delete(key));
      loadsInFlight.set(key, load);
    }
    if (await load) {
      await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
    }
  } catch (e) {
    console.warn('[LM Studio] Loading before the turn failed:', e);
  }
}
