import { inferContextWindowTokens, isGemmaFamily } from '@shared/index';

describe('isGemmaFamily', () => {
  it('detects Gemma model ids', () => {
    expect(isGemmaFamily('google/gemma-4-E4B-it')).toBe(true);
    expect(isGemmaFamily('Gemma-3-12B')).toBe(true);
    expect(isGemmaFamily('gpt-4o-mini')).toBe(false);
  });
});

describe('inferContextWindowTokens (OpenAI models)', () => {
  it('uses 200k for O-series reasoning models', () => {
    expect(inferContextWindowTokens('o1', 'openai')).toBe(200_000);
    expect(inferContextWindowTokens('o1-preview', 'openai')).toBe(200_000);
    expect(inferContextWindowTokens('o3', 'openai')).toBe(200_000);
    expect(inferContextWindowTokens('o3-mini', 'openai')).toBe(200_000);
  });

  it('uses 128k for GPT-4o family', () => {
    expect(inferContextWindowTokens('gpt-4o', 'openai')).toBe(128_000);
    expect(inferContextWindowTokens('gpt-4o-mini', 'openai')).toBe(128_000);
    expect(inferContextWindowTokens('gpt-4o-2024-08-06', 'openai')).toBe(128_000);
  });

  it('uses 8k for base GPT-4', () => {
    expect(inferContextWindowTokens('gpt-4', 'openai')).toBe(8_192);
  });

  it('uses 1M for GPT-5+', () => {
    expect(inferContextWindowTokens('gpt-5', 'openai')).toBe(1_000_000);
    expect(inferContextWindowTokens('gpt-5.4', 'openai')).toBe(1_000_000);
  });
});

describe('inferContextWindowTokens (Claude models)', () => {
  it('uses 200k for Claude 3.x and earlier', () => {
    expect(inferContextWindowTokens('claude-3-opus', 'openai')).toBe(200_000);
    expect(inferContextWindowTokens('claude-3.5-sonnet', 'openai')).toBe(200_000);
    expect(inferContextWindowTokens('claude-3-haiku', 'openai')).toBe(200_000);
  });

  it('uses 1M for Claude 4.6+ models', () => {
    expect(inferContextWindowTokens('claude-sonnet-4.6', 'openai')).toBe(1_000_000);
    expect(inferContextWindowTokens('claude-opus-4.7', 'openai')).toBe(1_000_000);
  });
});

describe('inferContextWindowTokens (Gemini models)', () => {
  it('uses 2M for Gemini 1.5 Pro', () => {
    expect(inferContextWindowTokens('gemini-1.5-pro', 'openai')).toBe(2_000_000);
  });

  it('uses 1M for other Gemini models', () => {
    expect(inferContextWindowTokens('gemini-1.5-flash', 'openai')).toBe(1_000_000);
    expect(inferContextWindowTokens('gemini-2.0-flash', 'openai')).toBe(1_000_000);
    expect(inferContextWindowTokens('gemini-2.5-pro', 'openai')).toBe(1_000_000);
  });
});

describe('inferContextWindowTokens (Llama models)', () => {
  it('uses 128k for Llama 3.1-3.3', () => {
    expect(inferContextWindowTokens('llama-3.1-70b', 'openai')).toBe(128_000);
    expect(inferContextWindowTokens('llama-3.2-3b', 'openai')).toBe(128_000);
    expect(inferContextWindowTokens('llama-3.3-70b', 'openai')).toBe(128_000);
  });

  it('uses 8k for older Llama 3', () => {
    expect(inferContextWindowTokens('llama-3-8b', 'openai')).toBe(8_192);
  });

  it('uses 1M+ for Llama 4', () => {
    expect(inferContextWindowTokens('llama-4-maverick', 'openai')).toBe(1_000_000);
    expect(inferContextWindowTokens('llama-4-scout', 'openai')).toBe(10_000_000);
  });
});

describe('inferContextWindowTokens (Qwen models)', () => {
  it('uses native 32k for Qwen 2/3 (not YaRN 128k)', () => {
    expect(inferContextWindowTokens('qwen2.5-7b', 'llamacpp')).toBe(32_768);
    expect(inferContextWindowTokens('Qwen2.5-14B-Instruct', 'lmstudio')).toBe(32_768);
    expect(inferContextWindowTokens('qwen3-32b', 'llamacpp')).toBe(32_768);
  });

  it('uses 1M for Qwen 2.5-1M', () => {
    expect(inferContextWindowTokens('qwen2.5-7b-instruct-1m', 'llamacpp')).toBe(1_000_000);
  });
});

describe('inferContextWindowTokens (Gemma LM Studio)', () => {
  it('uses 256k for 31B dense Gemma 4', () => {
    expect(inferContextWindowTokens('google/gemma-4-31b-it', 'lmstudio')).toBe(256_000);
  });

  it('uses 256k for 26B A4B sparse-expert style ids', () => {
    expect(inferContextWindowTokens('google/gemma-4-26b-a4b-it', 'lmstudio')).toBe(256_000);
  });

  it('uses 128k for E4B / E2B', () => {
    expect(inferContextWindowTokens('google/gemma-4-E4B-it', 'lmstudio')).toBe(128_000);
    expect(inferContextWindowTokens('google/gemma-4-E2B-it', 'lmstudio')).toBe(128_000);
  });

  it('uses 256k for Gemma 4 12B', () => {
    expect(inferContextWindowTokens('unsloth/gemma-4-12b-it-GGUF', 'llamacpp')).toBe(256_000);
    expect(inferContextWindowTokens('google/gemma-4-12B-it', 'lmstudio')).toBe(256_000);
  });

  it('uses 128k for Gemma 3 12B', () => {
    expect(inferContextWindowTokens('google/gemma-3-12b-it', 'llamacpp')).toBe(128_000);
  });

  it('uses 8k for Gemma 2', () => {
    expect(inferContextWindowTokens('google/gemma-2-9b-it', 'llamacpp')).toBe(8_192);
  });

  it('falls back for unknown LM Studio model', () => {
    expect(inferContextWindowTokens('local-model', 'lmstudio')).toBe(128_000);
    expect(inferContextWindowTokens('local-model', 'llamacpp')).toBe(128_000);
    expect(inferContextWindowTokens('google/gemma-4-E4B-it', 'llamacpp')).toBe(128_000);
  });
});
