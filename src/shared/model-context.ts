import type { LlmConnectionConfig } from './types/app-config';

const OPENAI_FALLBACK_CONTEXT_WINDOW = 128_000;
const LM_STUDIO_FALLBACK_CONTEXT_WINDOW = 32_768;

const MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /^gpt-4\.1($|[-:])/i, tokens: 1_047_576 },
  { pattern: /^gpt-4o-mini($|[-:])/i, tokens: 128_000 },
  { pattern: /^gpt-4o($|[-:])/i, tokens: 128_000 },
  { pattern: /^gpt-4-turbo($|[-:])/i, tokens: 128_000 },
  { pattern: /^gpt-4-1106/i, tokens: 128_000 },
  { pattern: /^gpt-4-0125/i, tokens: 128_000 },
  { pattern: /^gpt-4($|[-:])/i, tokens: 8_192 },
  { pattern: /^gpt-3\.5-turbo($|[-:])/i, tokens: 16_385 },
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
  }
  return provider === 'lmstudio' ? LM_STUDIO_FALLBACK_CONTEXT_WINDOW : OPENAI_FALLBACK_CONTEXT_WINDOW;
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
