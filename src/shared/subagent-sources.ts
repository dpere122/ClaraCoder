/**
 * The chat sources as sub-agent roles see them: what a role can run on, and whether the app can
 * start that source's server itself. Shared by Settings → Subagents and the home page.
 */
import { isPinnedLlamaServerUrlProviderId } from './llm-provider-ids';
import type { LlmProviderConfig } from './types/app-config';

export interface SubagentSource {
  /** The source's id in Settings (`LlmProviderConfig.id`); what a role stores. */
  id: string;
  /** The id main and the backend know the source by (its one model preset's id). */
  connectionId: string;
  label: string;
  provider: LlmProviderConfig['provider'];
  model: string;
  preset: string;
  /** Runs on this machine. */
  local: boolean;
  /** A local model with a run command: the app starts and stops its server. */
  launchable: boolean;
}

/** One source for roles, or null for a provider no role can use (no model preset, image generation). */
export function subagentSource(provider: LlmProviderConfig, label: string): SubagentSource | null {
  const model = provider.models[0];
  if (!model || provider.provider === 'python-t2i') {
    return null;
  }
  const managed = provider.provider === 'llamacpp' && !isPinnedLlamaServerUrlProviderId(provider.id);
  return {
    id: provider.id,
    connectionId: model.id,
    label,
    provider: provider.provider,
    model: model.model,
    preset: model.optimizationPreset,
    local: provider.provider === 'llamacpp' || provider.provider === 'lmstudio',
    launchable: managed && (model.llamaCppManaged?.chatRunCommand ?? '').trim() !== '',
  };
}

/** Every source a role can use, in the order given. */
export function subagentSources(
  providers: readonly LlmProviderConfig[],
  label: (provider: LlmProviderConfig) => string,
): SubagentSource[] {
  return providers.flatMap((provider) => subagentSource(provider, label(provider)) ?? []);
}
