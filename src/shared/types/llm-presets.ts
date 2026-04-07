import type { LlmOptimizationPreset } from './app-config';

export interface LlmOptimizationPresetMeta {
  id: LlmOptimizationPreset;
  label: string;
  description: string;
  /** If set, preset is only listed for these providers. */
  providers?: ReadonlyArray<'openai' | 'lmstudio'>;
}

/** Ordered list: Generic first in UI logic where we insert Qwen after generic — Qwen is the first *specialized* preset. */
export const LLM_OPTIMIZATION_PRESET_LIST: readonly LlmOptimizationPresetMeta[] = [
  {
    id: 'generic',
    label: 'Generic',
    description:
      'No forced family tuning. If the model id contains "qwen", the backend may still apply light auto-optimizations unless disabled via env.',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    description:
      'For Qwen-class models (e.g. Qwen 3.5 9B via LM Studio): single tool call per turn, higher max output, extra system prompt hints.',
    providers: ['openai', 'lmstudio'],
  },
] as const;

export function optimizationPresetsForProvider(provider: 'openai' | 'lmstudio'): LlmOptimizationPresetMeta[] {
  const filtered = LLM_OPTIMIZATION_PRESET_LIST.filter((p) => !p.providers || p.providers.includes(provider));
  if (provider === 'lmstudio') {
    const qwen = filtered.find((p) => p.id === 'qwen');
    const generic = filtered.find((p) => p.id === 'generic');
    const rest = filtered.filter((p) => p.id !== 'qwen' && p.id !== 'generic');
    if (qwen && generic) {
      return [qwen, generic, ...rest];
    }
  }
  return filtered;
}

/** Values applied when the user picks the Qwen template (they can edit afterward). */
export const QWEN_PRESET_DEFAULTS = {
  parallelToolCalls: false,
  maxOutputTokens: 8192,
  temperatureCap: 0.45,
} as const;
