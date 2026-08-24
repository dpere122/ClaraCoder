/**
 * Parse user-supplied HTTP(S) URLs for main-process fetch (LM Studio, OpenAI-compatible APIs).
 * Rejects non-network schemes and embedded credentials to limit SSRF / credential leakage.
 */
export function parseAllowedHttpUrl(raw: string): URL | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return null;
    }
    if (u.username || u.password) {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

/**
 * OpenAI ``/v1`` base URL → host root for management APIs (``/api/v1``).
 * Keeps a path prefix after stripping ``/v1`` (e.g. ``http://host/lms/v1`` → ``http://host/lms``).
 * Returns null when the URL is invalid.
 */
export function openAiBaseUrlToOrigin(baseUrl: string): string | null {
  const u = parseAllowedHttpUrl(baseUrl);
  if (!u) {
    return null;
  }
  let path = u.pathname.replace(/\/+$/, '') || '';
  if (path.toLowerCase().endsWith('/v1')) {
    path = path.slice(0, -3);
  }
  path = path.replace(/\/+$/, '');
  return `${u.origin}${path}`;
}
