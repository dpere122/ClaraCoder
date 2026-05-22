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

/** OpenAI ``/v1`` base URL → origin for management APIs; null when invalid. */
export function openAiBaseUrlToOrigin(baseUrl: string): string | null {
  const u = parseAllowedHttpUrl(baseUrl);
  if (!u) {
    return null;
  }
  let path = u.pathname.replace(/\/+$/, '') || '';
  if (path.endsWith('/v1')) {
    path = path.slice(0, -3);
  }
  u.pathname = path || '/';
  return u.origin;
}
