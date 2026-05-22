import { describe, expect, it } from 'vitest';
import { openAiBaseUrlToOrigin, parseAllowedHttpUrl } from './safe-http-url';

describe('parseAllowedHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(parseAllowedHttpUrl('http://127.0.0.1:1234/v1')?.origin).toBe('http://127.0.0.1:1234');
    expect(parseAllowedHttpUrl('https://example.com/v1')?.origin).toBe('https://example.com');
  });

  it('rejects non-network schemes', () => {
    expect(parseAllowedHttpUrl('file:///etc/passwd')).toBeNull();
    expect(parseAllowedHttpUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects embedded credentials', () => {
    expect(parseAllowedHttpUrl('http://user:pass@127.0.0.1:1234/v1')).toBeNull();
  });
});

describe('openAiBaseUrlToOrigin', () => {
  it('strips trailing /v1', () => {
    expect(openAiBaseUrlToOrigin('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234');
  });
});
