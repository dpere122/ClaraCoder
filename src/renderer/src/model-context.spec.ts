import { inferContextWindowTokens, isGemmaFamily } from '@shared/index';

describe('isGemmaFamily', () => {
  it('detects Gemma model ids', () => {
    expect(isGemmaFamily('google/gemma-4-E4B-it')).toBe(true);
    expect(isGemmaFamily('Gemma-3-12B')).toBe(true);
    expect(isGemmaFamily('gpt-4o-mini')).toBe(false);
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

  it('falls back for unknown LM Studio model', () => {
    expect(inferContextWindowTokens('local-model', 'lmstudio')).toBe(32_768);
    expect(inferContextWindowTokens('local-model', 'llamacpp')).toBe(32_768);
    expect(inferContextWindowTokens('google/gemma-4-E4B-it', 'llamacpp')).toBe(128_000);
  });
});
