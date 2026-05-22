import type { LlamacppManagedListModelsResult } from '../shared';
import { parseAllowedHttpUrl } from '../shared/safe-http-url';

/** OpenAI base URL (…/v1) → http origin for /health and non-``/v1`` routes. */
export function openAiV1BaseToServerRoot(openAiV1: string): string {
  const u = (openAiV1 || '').trim().replace(/\/$/, '');
  if (u.toLowerCase().endsWith('/v1')) {
    return u.slice(0, -3);
  }
  return u;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Lists model ids from an OpenAI-compatible ``GET {base}/models`` endpoint (e.g. llama-server).
 * ``openAiBaseUrl`` must already include the ``/v1`` suffix.
 */
export async function fetchOpenAiCompatibleModelIds(
  openAiBaseUrl: string,
  apiKey: string,
): Promise<LlamacppManagedListModelsResult> {
  const parsed = parseAllowedHttpUrl(openAiBaseUrl);
  if (!parsed) {
    return { ok: false, error: 'Invalid base URL' };
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/models`;
  const url = parsed.toString();
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = (apiKey || '').trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} from ${url}` };
    }
    const body = asRecord(await res.json().catch(() => null));
    const raw = body && Array.isArray(body.data) ? body.data : [];
    const models = raw
      .map((row) => {
        const r = asRecord(row);
        return r && typeof r.id === 'string' ? r.id.trim() : '';
      })
      .filter((id): id is string => !!id);
    return { ok: true, models };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg || 'Request failed' };
  }
}
