import { isPinnedLlamaServerUrlProviderId } from './llm-provider-ids';
import type { AppConfig, LlmConnectionConfig, LlmModelProfile, LlmProviderConfig } from './types/app-config';

/** Merge provider endpoint + model preset into the wire shape used by Python and context helpers. */
export function mergeLlmProviderModel(provider: LlmProviderConfig, model: LlmModelProfile): LlmConnectionConfig {
  const embBase = (provider.embeddingsBaseUrl ?? '').trim();
  return {
    ...model,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    embeddingsModel: provider.embeddingsModel,
    ...(embBase ? { embeddingsBaseUrl: embBase } : {}),
  };
}

/** Flatten all models to legacy connection rows (each row's `id` is the model profile id). */
export function flattenLlmProvidersToConnections(providers: LlmProviderConfig[]): LlmConnectionConfig[] {
  const out: LlmConnectionConfig[] = [];
  for (const p of providers) {
    for (const m of p.models) {
      out.push(mergeLlmProviderModel(p, m));
    }
  }
  return out;
}

export function findLlmModelLocation(
  providers: LlmProviderConfig[],
  modelId: string,
): { providerIndex: number; modelIndex: number; provider: LlmProviderConfig; model: LlmModelProfile } | null {
  for (let pi = 0; pi < providers.length; pi += 1) {
    const p = providers[pi];
    const mi = p.models.findIndex((m) => m.id === modelId);
    if (mi >= 0) {
      return { providerIndex: pi, modelIndex: mi, provider: p, model: p.models[mi] };
    }
  }
  return null;
}

export function countLlmModels(providers: LlmProviderConfig[]): number {
  return providers.reduce((acc, p) => acc + p.models.length, 0);
}

/** Active chat connection from nested config + `activeLlmModelId`. */
export function resolveActiveLlmConnection(config: AppConfig): LlmConnectionConfig | null {
  const loc = findLlmModelLocation(config.llmProviders, config.activeLlmModelId);
  if (!loc) {
    return null;
  }
  return mergeLlmProviderModel(loc.provider, loc.model);
}

/**
 * Active managed local ``llama-server`` (Start/Stop eligible).
 * Excludes the pinned URL-only remote row, which connects to an already-running server.
 */
export function findManagedLocalLlamaLocation(
  config: AppConfig,
): { providerIndex: number; modelIndex: number; provider: LlmProviderConfig; model: LlmModelProfile } | null {
  const mid = config.activeLlmModelId?.trim();
  if (!mid) {
    return null;
  }
  const loc = findLlmModelLocation(config.llmProviders, mid);
  if (!loc || loc.provider.provider !== 'llamacpp' || isPinnedLlamaServerUrlProviderId(loc.provider.id)) {
    return null;
  }
  return loc;
}

/**
 * Return a new providers tree with ``changes`` applied to the model preset ``modelId``.
 * Unknown ids leave ``providers`` unchanged. ``undefined`` values delete the field.
 */
export function patchLlmModelProfile(
  providers: LlmProviderConfig[],
  modelId: string,
  changes: Partial<LlmModelProfile>,
): LlmProviderConfig[] {
  const loc = findLlmModelLocation(providers, modelId);
  if (!loc) {
    return providers;
  }
  return providers.map((p, pi) => {
    if (pi !== loc.providerIndex) {
      return p;
    }
    return {
      ...p,
      models: p.models.map((m, mi) => {
        if (mi !== loc.modelIndex) {
          return m;
        }
        const next: LlmModelProfile = { ...m };
        const draft = next as unknown as Record<string, unknown>;
        for (const [key, val] of Object.entries(changes) as [keyof LlmModelProfile, unknown][]) {
          if (val === undefined) {
            delete draft[key as string];
          } else {
            draft[key as string] = val;
          }
        }
        return next;
      }),
    };
  });
}
