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
      'No Qwen/Gemma-specific profile. Pick Qwen or Gemma here when you want those templates; the backend does not infer them from the model id alone.',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    description:
      'For Qwen-class models (e.g. Qwen 3.5 9B via LM Studio): single tool call per turn, higher max output, extra system prompt hints.',
    providers: ['openai', 'lmstudio'],
  },
  {
    id: 'capable',
    label: 'Capable API',
    description:
      'For OpenAI and similar APIs that handle parallel tool calls well: enables parallel tool calls by default and adds prompt hints to batch independent reads.',
    providers: ['openai', 'lmstudio'],
  },
  {
    id: 'gemma',
    label: 'Gemma (LM Studio)',
    description:
      'For Google Gemma 3/4 via LM Studio: boolean thinking (on/off), recommended sampling (temp 1 / top_p 0.95 / top_k 64), higher default max output, MoE-aware notes. Does not use OpenAI-style reasoning_effort tiers.',
    providers: ['lmstudio'],
  },
] as const;

export function optimizationPresetsForProvider(provider: 'openai' | 'lmstudio'): LlmOptimizationPresetMeta[] {
  const filtered = LLM_OPTIMIZATION_PRESET_LIST.filter((p) => !p.providers || p.providers.includes(provider));
  if (provider === 'lmstudio') {
    const qwen = filtered.find((p) => p.id === 'qwen');
    const gemma = filtered.find((p) => p.id === 'gemma');
    const generic = filtered.find((p) => p.id === 'generic');
    const rest = filtered.filter((p) => p.id !== 'qwen' && p.id !== 'gemma' && p.id !== 'generic');
    if (qwen && gemma && generic) {
      return [qwen, gemma, generic, ...rest];
    }
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

/** Defaults applied when the user picks the Capable API optimization template. */
export const CAPABLE_PRESET_DEFAULTS = {
  parallelToolCalls: true,
} as const;

/** Defaults applied when the user picks the Gemma (LM Studio) optimization template. */
export const GEMMA_PRESET_DEFAULTS = {
  parallelToolCalls: false,
  maxOutputTokens: 16_384,
  temperature: 1.0,
  samplingPreset: 'gemma-recommended' as const,
  thinkingMode: 'on' as const,
  architectureHint: 'auto' as const,
  topP: 0.95,
  topK: 64,
} as const;
