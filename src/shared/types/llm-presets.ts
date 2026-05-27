import type { LlmOptimizationPreset, LlmProviderConfig } from './app-config';

export interface LlmOptimizationPresetMeta {
  id: LlmOptimizationPreset;
  label: string;
  description: string;
  /** If set, preset is only listed for these providers. */
  providers?: ReadonlyArray<LlmProviderConfig['provider']>;
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
      'For Qwen-class models (e.g. Qwen 3.5 27B via LM Studio): Extra system prompt hints, and `read_workspace_image` for workspace PNG/JPEG/GIF/WebP/BMP. Managed llama-server adds --jinja and --chat-template-file for the bundled Qwen Jinja template (recent llama.cpp with Jinja support).',
    providers: ['openai', 'lmstudio', 'llamacpp'],
  },
  {
    id: 'capable',
    label: 'Capable API',
    description:
      'For OpenAI and similar APIs that handle parallel tool calls well: enables parallel tool calls by default and adds prompt hints to batch independent reads.',
    providers: ['openai', 'lmstudio', 'llamacpp'],
  },
  {
    id: 'gemma',
    label: 'Gemma (local)',
    description:
      'For Google Gemma 3/4 via LM Studio or llama.cpp: boolean thinking (on/off), recommended sampling (temp 1 / top_p 0.95 / top_k 64), higher default max output, and sparse-expert layout notes when the model id suggests a 26B A4B–style variant. Does not use OpenAI-style reasoning_effort tiers. Note: the server’s loaded context length (n_ctx, often tens of thousands of tokens) caps prompt plus completion; it can be far below the model’s trained context in GGUF metadata.',
    providers: ['lmstudio', 'llamacpp'],
  },
] as const;

export function optimizationPresetsForProvider(provider: LlmProviderConfig['provider']): LlmOptimizationPresetMeta[] {
  const filtered = LLM_OPTIMIZATION_PRESET_LIST.filter((p) => !p.providers || p.providers.includes(provider));
  if (provider === 'lmstudio' || provider === 'llamacpp') {
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

/** Defaults applied when the user picks the Gemma (local) optimization template. */
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
