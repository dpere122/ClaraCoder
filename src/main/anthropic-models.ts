/**
 * Claude model catalog (Models API) and the status Settings shows. Lists with the key from
 * {@link getAnthropicApiKey}; nothing here returns the key itself.
 *
 * Each model's ``capabilities`` also feed the per-connection reasoning-caps cache, so the
 * composer's effort dropdown and the backend's thinking settings follow the selected model.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo } from '@anthropic-ai/sdk/resources/models';
import type {
  AnthropicCatalogModel,
  AnthropicListModelsResult,
  AnthropicStatus,
  AppConfig,
  ChatTemplateReasoningCaps,
  LlmConnectionConfig,
} from '../shared';
import { ANTHROPIC_EFFORT_ORDER, anthropicReasoningCaps, flattenLlmProvidersToConnections } from '../shared';
import { anthropicKeyHint, getAnthropicApiKey, getAnthropicKeyStorage } from './anthropic-key-store';
import { clearCachedChatTemplateReasoning, setCachedChatTemplateReasoning } from './chat-template-reasoning-cache';

/** Model metadata changes rarely; one list per hour unless Settings asks for a refresh. */
const CATALOG_TTL_MS = 60 * 60 * 1000;
/** After a failed list with nothing cached, try again on the next request after this. */
const FAILED_RETRY_MS = 60 * 1000;
const LIST_TIMEOUT_MS = 15_000;
/** Python runtime sync waits at most this long; a slower list still fills the cache for next time. */
const SYNC_WAIT_MS = 5_000;

type ModelsClient = Pick<Anthropic, 'models'>;
type ClientFactory = (apiKey: string) => ModelsClient;

const defaultClientFactory: ClientFactory = (apiKey) =>
  new Anthropic({ apiKey, timeout: LIST_TIMEOUT_MS, maxRetries: 1 });

let clientFactory: ClientFactory = defaultClientFactory;

/** Test hook: swap the SDK client (``null`` restores the real one) and drop cached state. */
export function setAnthropicClientFactoryForTests(factory: ClientFactory | null): void {
  clientFactory = factory ?? defaultClientFactory;
  resetAnthropicCatalog();
}

type CatalogState = {
  /** Hint of the key this state belongs to; a different key starts over. */
  keyHint: string;
  fetchedAt: number;
  models: AnthropicCatalogModel[] | null;
  verifiedAt?: number;
  error?: string;
};

let state: CatalogState | null = null;
let inFlight: { keyHint: string; promise: Promise<CatalogState> } | null = null;

/** Forget the catalog (key changed or removed). */
export function resetAnthropicCatalog(): void {
  state = null;
  inFlight = null;
}

function supported(leaf: { supported?: boolean } | null | undefined): boolean {
  return leaf?.supported === true;
}

/** One Models API row; ``null`` for retired models (requests naming them fail). */
export function parseAnthropicModel(info: ModelInfo): AnthropicCatalogModel | null {
  if (!info?.id || info.lifecycle === 'retired') {
    return null;
  }
  const caps = info.capabilities;
  const effort = caps?.effort;
  const effortLevels = supported(effort)
    ? ANTHROPIC_EFFORT_ORDER.filter((level) => supported((effort as unknown as Record<string, { supported?: boolean } | null>)[level]))
    : [];
  const model: AnthropicCatalogModel = {
    id: info.id,
    displayName: (info.display_name || '').trim() || info.id,
    maxInputTokens: info.max_input_tokens && info.max_input_tokens > 0 ? info.max_input_tokens : 0,
    maxOutputTokens: info.max_tokens && info.max_tokens > 0 ? info.max_tokens : 0,
    deprecated: info.lifecycle === 'deprecated',
    vision: supported(caps?.image_input),
    adaptiveThinking: supported(caps?.thinking?.types?.adaptive),
    effortLevels,
    structuredOutputs: supported(caps?.structured_outputs),
  };
  if (info.created_at && !info.created_at.startsWith('1970')) {
    model.createdAt = info.created_at;
  }
  if (info.line) {
    model.line = info.line;
  }
  if (info.retires_at) {
    model.retiresAt = info.retires_at;
  }
  return model;
}

/** Friendly message for a failed list; the SDK's typed errors tell a bad key from an outage. */
export function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'The API key was rejected (401). Check that it is a current Claude Console key.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'The API key does not have permission to list models (403).';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited while listing models (429). Try again shortly.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Claude API. Check your network connection.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** True when the failure means the key itself is bad (not an outage). */
export function isAnthropicAuthError(err: unknown): boolean {
  return err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError;
}

/** List every non-retired model the key can use, newest first. Throws the SDK's typed errors. */
export async function listAnthropicModels(apiKey: string): Promise<AnthropicCatalogModel[]> {
  const client = clientFactory(apiKey);
  const models: AnthropicCatalogModel[] = [];
  for await (const info of client.models.list({ limit: 100 })) {
    const model = parseAnthropicModel(info);
    if (model) {
      models.push(model);
    }
  }
  return models.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

async function loadCatalog(force: boolean): Promise<CatalogState | null> {
  const key = await getAnthropicApiKey();
  if (!key) {
    resetAnthropicCatalog();
    return null;
  }
  const keyHint = anthropicKeyHint(key);
  if (state && state.keyHint !== keyHint) {
    state = null;
  }
  const ttl = state?.models ? CATALOG_TTL_MS : FAILED_RETRY_MS;
  if (!force && state && Date.now() - state.fetchedAt < ttl) {
    return state;
  }
  if (inFlight && inFlight.keyHint === keyHint) {
    return inFlight.promise;
  }
  const previous = state;
  const promise = listAnthropicModels(key)
    .then((models): CatalogState => ({ keyHint, fetchedAt: Date.now(), models, verifiedAt: Date.now() }))
    .catch((err: unknown): CatalogState => {
      const error = describeAnthropicError(err);
      console.warn('[anthropic] Model list failed:', error);
      // Keep a stale list over none when a refresh fails for a reason other than the key.
      const keep = !isAnthropicAuthError(err) && previous?.keyHint === keyHint ? previous.models : null;
      return { keyHint, fetchedAt: Date.now(), models: keep, verifiedAt: keep ? previous?.verifiedAt : undefined, error };
    })
    .then((next) => {
      state = next;
      return next;
    })
    .finally(() => {
      if (inFlight?.promise === promise) {
        inFlight = null;
      }
    });
  inFlight = { keyHint, promise };
  return promise;
}

/** Status for Settings. ``refresh`` re-lists models even when the cached list is fresh. */
export async function getAnthropicStatus(refresh = false): Promise<AnthropicListModelsResult> {
  const key = await getAnthropicApiKey();
  const storage = await getAnthropicKeyStorage();
  const base: AnthropicStatus = { configured: !!key, storage, keyHint: anthropicKeyHint(key), models: [] };
  if (!key) {
    return { ok: true, status: base };
  }
  const catalog = await loadCatalog(refresh);
  const status: AnthropicStatus = {
    ...base,
    models: catalog?.models ?? [],
    ...(catalog?.verifiedAt ? { verifiedAt: catalog.verifiedAt } : {}),
    ...(catalog?.error ? { error: catalog.error } : {}),
  };
  return catalog?.error && !catalog.models ? { ok: false, error: catalog.error, status } : { ok: true, status };
}

/** Cached catalog row for a model id, listing first when nothing is cached. */
export async function findAnthropicModel(modelId: string): Promise<AnthropicCatalogModel | undefined> {
  const catalog = await loadCatalog(false);
  return catalog?.models?.find((m) => m.id === modelId.trim());
}

/**
 * Recomputes and caches caps for one Claude connection. ``undefined`` (cache cleared) when the
 * catalog is unreachable or does not list the model.
 */
export async function refreshAnthropicReasoningForConnection(
  connection: LlmConnectionConfig,
): Promise<ChatTemplateReasoningCaps | undefined> {
  const model = connection.model.trim() ? await findAnthropicModel(connection.model) : undefined;
  if (!model) {
    clearCachedChatTemplateReasoning(connection.id);
    return undefined;
  }
  const caps = anthropicReasoningCaps(model);
  setCachedChatTemplateReasoning(connection.id, caps);
  return caps;
}

/** The Claude connection with this id, or null for other providers / unknown ids. */
export function findAnthropicConnection(config: AppConfig, connectionId: string): LlmConnectionConfig | null {
  const connection = flattenLlmProvidersToConnections(config.llmProviders).find((c) => c.id === connectionId);
  return connection?.provider === 'anthropic' ? connection : null;
}

/** Refreshes caps for every Claude connection ahead of a Python runtime sync. */
export async function refreshAnthropicReasoningCaps(config: AppConfig): Promise<void> {
  const connections = flattenLlmProvidersToConnections(config.llmProviders).filter(
    (c) => c.provider === 'anthropic' && c.model.trim(),
  );
  if (!connections.length) {
    return;
  }
  const refresh = Promise.all(connections.map((c) => refreshAnthropicReasoningForConnection(c))).catch((err) => {
    console.warn('[anthropic] Reasoning caps refresh failed:', err);
  });
  await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))]);
}
