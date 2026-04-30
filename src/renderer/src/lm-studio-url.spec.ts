import { lmStudioOpenAiBaseUrlToRestOrigin } from '@shared/index';

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
