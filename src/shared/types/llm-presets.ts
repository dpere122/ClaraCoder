import type { LlmOptimizationPreset, LlmProviderConfig } from './app-config';

export interface LlmOptimizationPresetMeta {
  id: LlmOptimizationPreset;
  label: string;
  /** One line for the Models Ready defaults header. */
  summary: string;
  description: string;
  /** If set, preset is only listed for these providers. */
  providers?: ReadonlyArray<LlmProviderConfig['provider']>;
}

/** Ordered list for the Models Template dropdown: Generic is always first. */
export const LLM_OPTIMIZATION_PRESET_LIST: readonly LlmOptimizationPresetMeta[] = [
  {
    id: 'generic',
    label: 'Generic',
    summary: 'No family-specific prompt or sampling profile.',
    description:
      'No Qwen/Gemma-specific profile. Pick Qwen or Gemma here when you want those templates; the backend does not infer them from the model id alone.',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    summary: 'Qwen prompt hints, vision tool, and llama Jinja.',
    description:
      'For Qwen-class models (e.g. Qwen 3.5 27B via LM Studio): Extra system prompt hints, and `read_workspace_image` for workspace PNG/JPEG/GIF/WebP/BMP. Managed llama-server adds --jinja and --chat-template-file for the bundled Qwen Jinja template (recent llama.cpp with Jinja support).',
    providers: ['openai', 'lmstudio', 'llamacpp'],
  },
  {
    id: 'gemma',
    label: 'Gemma (local)',
    summary: 'Thinking on/off, recommended sampling, llama Jinja.',
    description:
      'For Google Gemma 3/4 via LM Studio or llama.cpp: boolean thinking (on/off) maps to llama-server enable_thinking, applies recommended sampling onto the connection (temp 1 / top_p 0.95 / top_k 64), max output left automatic (0), sparse-expert layout notes when the model id suggests a 26B A4B–style variant, managed llama-server adds --jinja and the bundled Gemma 4 Jinja template, and <|channel>thought output is split into the reasoning stream in the UI. Does not use OpenAI-style reasoning_effort tiers. Note: the server’s loaded context length (n_ctx) caps prompt plus completion.',
    providers: ['lmstudio', 'llamacpp'],
  },
] as const;

export function optimizationPresetsForProvider(provider: LlmProviderConfig['provider']): LlmOptimizationPresetMeta[] {
  const filtered = LLM_OPTIMIZATION_PRESET_LIST.filter((p) => !p.providers || p.providers.includes(provider));
  const generic = filtered.find((p) => p.id === 'generic');
  const rest = filtered.filter((p) => p.id !== 'generic');
  return generic ? [generic, ...rest] : rest;
}

/** Values applied when the user picks the Qwen template (they can edit afterward). */
export const QWEN_PRESET_DEFAULTS = {
  parallelToolCalls: false,
  maxOutputTokens: 0,
  /** Recommended chat temperature for Qwen coding profiles. */
  temperature: 0.65,
  topP: 0.95,
  topK: 20,
  repeatPenalty: 1,
} as const;

/** Defaults applied when the user picks the Gemma (local) optimization template. */
export const GEMMA_PRESET_DEFAULTS = {
  parallelToolCalls: false,
  maxOutputTokens: 0,
  temperature: 1.0,
  /** Connection ``top_p`` / ``top_k`` drive inference; keep sampling preset neutral. */
  samplingPreset: 'provider-default' as const,
  thinkingMode: 'on' as const,
  architectureHint: 'auto' as const,
  topP: 0.95,
  topK: 64,
} as const;
