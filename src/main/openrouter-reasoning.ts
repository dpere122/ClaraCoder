/**
 * Reasoning caps for OpenRouter connections, from each model's catalog ``reasoning`` block.
 * Stored in the same per-connection cache as llama.cpp chat-template caps, so the composer's
 * toggle / effort controls and the backend's effort allow-list follow the selected model.
 */
import type { AppConfig, ChatTemplateReasoningCaps, LlmConnectionConfig, OpenRouterCatalogModel } from '../shared';
import { flattenLlmProvidersToConnections, openRouterReasoningCaps } from '../shared';
import { unwrapSecret } from '../shared/types/app-config';
import { clearCachedChatTemplateReasoning, setCachedChatTemplateReasoning } from './chat-template-reasoning-cache';
import { fetchOpenRouterCatalog } from './openrouter-models';

/** Model metadata changes rarely; one catalog fetch per hour per base URL. */
const CATALOG_TTL_MS = 60 * 60 * 1000;
/** After a failed fetch with nothing cached, try again on the next request after this. */
const FAILED_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
/** Python runtime sync waits at most this long; a slower fetch still fills the cache for next time. */
const SYNC_WAIT_MS = 5_000;

type Catalog = ReadonlyMap<string, OpenRouterCatalogModel>;

const catalogs = new Map<string, { fetchedAt: number; models: Catalog | null }>();
const catalogFetches = new Map<string, Promise<Catalog | null>>();

const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

async function catalogFor(baseUrl: string, apiKey: string): Promise<Catalog | null> {
  const key = baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  const cached = catalogs.get(key);
  if (cached && Date.now() - cached.fetchedAt < (cached.models ? CATALOG_TTL_MS : FAILED_RETRY_MS)) {
    return cached.models;
  }
  const inFlight = catalogFetches.get(key);
  if (inFlight) {
    return inFlight;
  }
  const fetching = fetchOpenRouterCatalog(baseUrl, apiKey, fetchWithTimeout)
    .then((result) => {
      if (!result.ok) {
        console.warn('[OpenRouter] Model catalog unavailable; reasoning controls fall back to defaults:', result.error);
      }
      // Keep a stale catalog over none when a refresh fails.
      const models = result.ok ? new Map(result.models.map((m) => [m.id, m])) : (cached?.models ?? null);
      catalogs.set(key, { fetchedAt: Date.now(), models });
      return models;
    })
    .finally(() => catalogFetches.delete(key));
  catalogFetches.set(key, fetching);
  return fetching;
}

/**
 * Recomputes and caches caps for one OpenRouter connection. ``undefined`` (cache cleared) when
 * the catalog is unreachable or does not list the model, so the UI keeps its generic controls.
 */
export async function refreshOpenRouterReasoningForConnection(
  connection: LlmConnectionConfig,
): Promise<ChatTemplateReasoningCaps | undefined> {
  const catalog = await catalogFor(connection.baseUrl, unwrapSecret(connection.apiKey));
  const model = catalog?.get(connection.model.trim());
  if (!model) {
    clearCachedChatTemplateReasoning(connection.id);
    return undefined;
  }
  const caps = openRouterReasoningCaps(model.reasoning);
  setCachedChatTemplateReasoning(connection.id, caps);
  return caps;
}

/** The OpenRouter connection with this id, or null for other providers / unknown ids. */
export function findOpenRouterConnection(config: AppConfig, connectionId: string): LlmConnectionConfig | null {
  const connection = flattenLlmProvidersToConnections(config.llmProviders).find((c) => c.id === connectionId);
  return connection?.provider === 'openrouter' ? connection : null;
}

/** Refreshes caps for every OpenRouter connection ahead of a Python runtime sync. */
export async function refreshOpenRouterReasoningCaps(config: AppConfig): Promise<void> {
  const connections = flattenLlmProvidersToConnections(config.llmProviders).filter(
    (c) => c.provider === 'openrouter' && c.model.trim(),
  );
  if (!connections.length) {
    return;
  }
  const refresh = Promise.all(connections.map((c) => refreshOpenRouterReasoningForConnection(c))).catch((err) => {
    console.warn('[OpenRouter] Reasoning caps refresh failed:', err);
  });
  await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))]);
}
