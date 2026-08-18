import { effectiveLmStudioContextTokens, lmStudioOpenAiBaseUrlToRestOrigin } from '@shared/index';

describe('lmStudioOpenAiBaseUrlToRestOrigin', () => {
  it('strips trailing /v1 from OpenAI-compatible base', () => {
    expect(lmStudioOpenAiBaseUrlToRestOrigin('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234');
  });

  it('handles base without path', () => {
    expect(lmStudioOpenAiBaseUrlToRestOrigin('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
  });

  it('returns null for empty', () => {
    expect(lmStudioOpenAiBaseUrlToRestOrigin('')).toBeNull();
  });
});

describe('effectiveLmStudioContextTokens', () => {
  it('prefers loaded instance context over the architectural max', () => {
    expect(
      effectiveLmStudioContextTokens({ max_context_length: 131072, loaded_context_length: 8192 }),
    ).toBe(8192);
  });

  it('falls back to max when the model is not loaded', () => {
    expect(
      effectiveLmStudioContextTokens({ max_context_length: 32768, loaded_context_length: 0 }),
    ).toBe(32768);
  });
});
