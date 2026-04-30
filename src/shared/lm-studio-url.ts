/**
 * LM Studio serves OpenAI-compatible chat at ``/v1`` and native management APIs at ``/api/v1`` on the same host.
 */
export function lmStudioOpenAiBaseUrlToRestOrigin(baseUrl: string): string | null {
  const raw = (baseUrl || '').trim();
  if (!raw) {
    return null;
  }
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    let path = u.pathname.replace(/\/+$/, '') || '';
    if (path.endsWith('/v1')) {
      path = path.slice(0, -3);
    }
    u.pathname = path || '/';
    return u.origin;
  } catch {
    return null;
  }
}
