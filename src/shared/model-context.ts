import type { LlmConnectionConfig } from './types/app-config';

const OPENAI_FALLBACK_CONTEXT_WINDOW = 128_000;
const LM_STUDIO_FALLBACK_CONTEXT_WINDOW = 128_000;

/** True when the model id is likely Google Gemma (local or API name). */
export function isGemmaFamily(model: string): boolean {
  return (model || '').toLowerCase().includes('gemma');
}

const MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; tokens: number }> = [
  // OpenAI O-series reasoning models (200k context)
  { pattern: /^o1($|[-:])/i, tokens: 200_000 },
  { pattern: /^o3($|[-:])/i, tokens: 200_000 },

  // OpenAI GPT-5+ (1M context)
  { pattern: /^gpt-5/i, tokens: 1_000_000 },

  // OpenAI GPT-4o family (128k context)
  { pattern: /^gpt-4o-mini($|[-:])/i, tokens: 128_000 },
  { pattern: /^gpt-4o($|[-:])/i, tokens: 128_000 },
  { pattern: /^chatgpt-4o/i, tokens: 128_000 },

  // OpenAI GPT-4 Turbo (128k context)
  { pattern: /^gpt-4-turbo($|[-:])/i, tokens: 128_000 },
  { pattern: /^gpt-4-1106/i, tokens: 128_000 },
  { pattern: /^gpt-4-0125/i, tokens: 128_000 },

  // OpenAI GPT-4 base (8k context)
  { pattern: /^gpt-4($|[-:])/i, tokens: 8_192 },

  // OpenAI GPT-3.5 (16k context)
  { pattern: /^gpt-3\.5-turbo($|[-:])/i, tokens: 16_385 },

  // Anthropic Claude (200k base context, 1M for newer Opus/Sonnet 4.6+)
  { pattern: /claude.*(opus|sonnet).*4\.[6-9]/i, tokens: 1_000_000 },
  { pattern: /claude.*mythos/i, tokens: 1_000_000 },
  { pattern: /claude/i, tokens: 200_000 },

  // Google Gemini (1M-2M context)
  { pattern: /gemini.*1\.5.*pro/i, tokens: 2_000_000 },
  { pattern: /gemini.*1\.5/i, tokens: 1_000_000 },
  { pattern: /gemini.*2\.[05]/i, tokens: 1_000_000 },
  { pattern: /gemini.*3/i, tokens: 1_000_000 },
  { pattern: /gemini/i, tokens: 1_000_000 },

  // Meta Llama 4 (1M-10M context)
  { pattern: /llama.*4.*scout/i, tokens: 10_000_000 },
  { pattern: /llama.*4/i, tokens: 1_000_000 },

  // Meta Llama 3.x (128k context)
  { pattern: /llama.*3\.[1-3]/i, tokens: 128_000 },
  { pattern: /llama.*3/i, tokens: 8_192 },

  // Mistral models
  { pattern: /mistral.*large/i, tokens: 128_000 },
  { pattern: /mixtral/i, tokens: 32_000 },
  { pattern: /mistral/i, tokens: 32_000 },

  // Qwen models (128k+ for Qwen 2+)
  { pattern: /qwen.*2/i, tokens: 128_000 },
  { pattern: /qwen/i, tokens: 32_000 },

  // DeepSeek models
  { pattern: /deepseek.*v3/i, tokens: 128_000 },
  { pattern: /deepseek.*v2/i, tokens: 128_000 },
  { pattern: /deepseek.*coder/i, tokens: 128_000 },
  { pattern: /deepseek/i, tokens: 64_000 },

  // Cohere Command R+ (128k context)
  { pattern: /command.*r\+/i, tokens: 128_000 },
  { pattern: /command/i, tokens: 128_000 },
];

export function inferContextWindowTokens(
  model: string,
  provider: LlmConnectionConfig['provider'],
): number {
  const normalized = model.trim();
  if (normalized) {
    const match = MODEL_CONTEXT_WINDOWS.find((entry) => entry.pattern.test(normalized));
    if (match) {
      return match.tokens;
    }
    const m = normalized.toLowerCase();
    if ((provider === 'lmstudio' || provider === 'llamacpp') && m.includes('gemma')) {
      if (/\b31b\b/.test(m)) {
        return 256_000;
      }
      if (/\b26b\b/.test(m) && /\ba4b\b/.test(m)) {
        return 256_000;
      }
      if (/\ba4b\b/.test(m)) {
        return 256_000;
      }
      if (/\be2b\b/.test(m) || /\be4b\b/.test(m)) {
        return 128_000;
      }
      if (/gemma[-_.]?4\b/.test(m)) {
        return 256_000;
      }
      return 128_000;
    }
  }
  return provider === 'lmstudio' || provider === 'llamacpp'
    ? LM_STUDIO_FALLBACK_CONTEXT_WINDOW
    : OPENAI_FALLBACK_CONTEXT_WINDOW;
}

export function resolveContextWindowTokens(
  connection: Pick<LlmConnectionConfig, 'contextWindowTokens' | 'model' | 'provider'> | null | undefined,
): number {
  if (!connection) {
    return OPENAI_FALLBACK_CONTEXT_WINDOW;
  }
  if (Number.isFinite(connection.contextWindowTokens) && connection.contextWindowTokens > 0) {
    return Math.floor(connection.contextWindowTokens);
  }
  return inferContextWindowTokens(connection.model, connection.provider);
}
