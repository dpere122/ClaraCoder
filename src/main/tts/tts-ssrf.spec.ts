/**
 * Tests for security/tts-ssrf-errorleak — SSRF host validation and base-URL normalization.
 */
import { describe, it, expect } from 'vitest';

import { isPrivateHost } from './types';
import { normalizeOpenAiBaseUrl } from './openai_compatible/normalize-base-url';

describe('isPrivateHost', () => {
  it.each([
    ['loopback IPv4', 'http://127.0.0.1/'],
    ['localhost', 'http://localhost/'],
    ['loopback IPv6', 'http://[::1]/'],
    ['unspecified IPv4', 'http://0.0.0.0/'],
    ['unspecified IPv6', 'http://[::]/'],
    ['RFC1918 10/8', 'http://10.0.0.5/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['RFC1918 172.16/12', 'http://172.16.0.1/'],
    ['link-local 169.254/16', 'http://169.254.169.254/'],
    ['CGNAT 100.64/10', 'http://100.64.0.1/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['ULA fc00::/7', 'http://[fc00::1]/'],
    ['link-local IPv6 fe80', 'http://[fe80::1]/'],
  ])('blocks %s', (_label, url) => {
    expect(isPrivateHost(new URL(url))).toBe(true);
  });

  it.each([
    ['public IPv4', 'http://8.8.8.8/'],
    ['public IPv6', 'http://[2606:4700::]/'],
    ['public host', 'https://api.openai.com/'],
  ])('allows %s', (_label, url) => {
    expect(isPrivateHost(new URL(url))).toBe(false);
  });

  it('treats an empty host as private', () => {
    // file:/// has no hostname.
    expect(isPrivateHost(new URL('file:///etc/passwd'))).toBe(true);
  });
});

describe('normalizeOpenAiBaseUrl', () => {
  it('strips /v1 suffix', () => {
    expect(normalizeOpenAiBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com');
  });

  it('strips /v1/audio/speech suffix', () => {
    expect(normalizeOpenAiBaseUrl('https://api.openai.com/v1/audio/speech')).toBe(
      'https://api.openai.com',
    );
  });

  it('strips /v1/audio suffix', () => {
    expect(normalizeOpenAiBaseUrl('https://api.openai.com/v1/audio')).toBe(
      'https://api.openai.com',
    );
  });

  it('returns the origin when no path', () => {
    expect(normalizeOpenAiBaseUrl('https://api.openai.com')).toBe('https://api.openai.com');
  });

  it('rejects non-http schemes', () => {
    expect(normalizeOpenAiBaseUrl('ftp://example.com/')).toBeNull();
  });

  it('rejects embedded credentials', () => {
    expect(normalizeOpenAiBaseUrl('http://user:pass@example.com/')).toBeNull();
  });

  it('rejects an empty host', () => {
    expect(normalizeOpenAiBaseUrl('http:///')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(normalizeOpenAiBaseUrl('')).toBeNull();
  });
});
