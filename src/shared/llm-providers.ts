import type { AppConfig, LlmConnectionConfig, LlmModelProfile, LlmProviderConfig } from './types/app-config';

/** Merge provider endpoint + model preset into the wire shape used by Python and context helpers. */
export function mergeLlmProviderModel(provider: LlmProviderConfig, model: LlmModelProfile): LlmConnectionConfig {
  return {
    ...model,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    embeddingsModel: provider.embeddingsModel,
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
