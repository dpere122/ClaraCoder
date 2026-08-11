import { parseAllowedHttpUrl } from '../../../shared/safe-http-url';

/**
 * Validate + normalize an OpenAI-compatible TTS base URL.
 * Rejects non-http(s), embedded credentials, and empty host; strips common
 * ``/v1`` / ``/v1/audio`` / ``/v1/audio/speech`` suffixes pasted by mistake.
 */
export function normalizeOpenAiBaseUrl(baseUrl: string): string | null {
  const u = parseAllowedHttpUrl(baseUrl);
  if (!u || !u.hostname) {
    return null;
  }
  let path = u.pathname.replace(/\/+$/, '') || '';
  path = path.replace(/\/v1\/audio\/speech$/i, '');
  path = path.replace(/\/v1\/audio$/i, '');
  if (path.toLowerCase().endsWith('/v1')) {
    path = path.slice(0, -3);
  }
  path = path.replace(/\/+$/, '') || '';
  u.pathname = path || '/';
  u.search = '';
  u.hash = '';
  if (!path) {
    return u.origin;
  }
  return `${u.origin}${path}`;
}
