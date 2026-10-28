import type {
  OpenRouterCatalogModel,
  OpenRouterListModelsResult,
  OpenRouterPricing,
  OpenRouterReasoningInfo,
} from '../shared';
import { parseAllowedHttpUrl } from '../shared/safe-http-url';

/** Stop following ``links.next`` if OpenRouter ever loops. */
const MAX_CATALOG_PAGES = 20;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined;
}

/** The model's ``reasoning`` block; ``undefined`` when absent (the model does not reason). */
function parseReasoning(raw: unknown): OpenRouterReasoningInfo | undefined {
  const r = asRecord(raw);
  if (!r) {
    return undefined;
  }
  const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
  const info: OpenRouterReasoningInfo = {
    mandatory: r.mandatory === true,
    supportedEfforts: efforts.map(nonEmptyString).filter((e): e is string => !!e),
  };
  const defaultEffort = nonEmptyString(r.default_effort);
  if (defaultEffort) {
    info.defaultEffort = defaultEffort;
  }
  if (typeof r.default_enabled === 'boolean') {
    info.defaultEnabled = r.default_enabled;
  }
  return info;
}

/** A per-token USD price; OpenRouter sends decimal strings, and ``-1`` for variable-priced routers. */
function parsePrice(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The ``pricing`` block; ``undefined`` unless both prompt and completion prices parse. */
function parsePricing(raw: unknown): OpenRouterPricing | undefined {
  const r = asRecord(raw);
  const prompt = parsePrice(r?.prompt);
  const completion = parsePrice(r?.completion);
  return prompt !== undefined && completion !== undefined ? { prompt, completion } : undefined;
}

/** Parse one OpenRouter models page. ``next`` is ``links.next`` when present. */
export function parseOpenRouterModelsPage(body: unknown): { models: OpenRouterCatalogModel[]; next: string | null } {
  const rec = asRecord(body);
  const raw = rec && Array.isArray(rec.data) ? rec.data : [];
  const models: OpenRouterCatalogModel[] = [];
  for (const row of raw) {
    const r = asRecord(row);
    if (!r || typeof r.id !== 'string') {
      continue;
    }
    const id = r.id.trim();
    if (!id) {
      continue;
    }
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id;
    const contextLength =
      typeof r.context_length === 'number' && Number.isFinite(r.context_length) && r.context_length > 0
        ? Math.floor(r.context_length)
        : 0;
    const model: OpenRouterCatalogModel = { id, name, contextLength };
    const reasoning = parseReasoning(r.reasoning);
    if (reasoning) {
      model.reasoning = reasoning;
    }
    const pricing = parsePricing(r.pricing);
    if (pricing) {
      model.pricing = pricing;
    }
    if (typeof r.created === 'number' && Number.isFinite(r.created) && r.created > 0) {
      model.created = Math.floor(r.created);
    }
    models.push(model);
  }
  const links = asRecord(rec?.links);
  const nextRaw = links && typeof links.next === 'string' ? links.next.trim() : '';
  return { models, next: nextRaw || null };
}

function modelsUrl(openAiBaseUrl: string): URL | null {
  const parsed = parseAllowedHttpUrl(openAiBaseUrl);
  if (!parsed) {
    return null;
  }
  let path = parsed.pathname.replace(/\/+$/, '') || '';
  if (!path.toLowerCase().endsWith('/v1')) {
    path = `${path}/v1`;
  }
  parsed.pathname = `${path}/models`;
  parsed.search = '';
  parsed.searchParams.set('supported_parameters', 'tools');
  return parsed;
}

/** Keep pagination on the same host, and keep the tool-capable filter if the next link drops it. */
export function resolveOpenRouterNextUrl(currentUrl: string, next: string, allowedHost: string): string | null {
  try {
    const u = new URL(next, currentUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return null;
    }
    if (u.username || u.password) {
      return null;
    }
    if (u.hostname.toLowerCase() !== allowedHost.toLowerCase()) {
      return null;
    }
    if (!u.searchParams.has('supported_parameters')) {
      u.searchParams.set('supported_parameters', 'tools');
    }
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * List tool-capable OpenRouter models (``id``, ``name``, ``context_length``, ``reasoning``, ``pricing``, ``created``),
 * following ``links.next``.
 */
export async function fetchOpenRouterCatalog(
  openAiBaseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterListModelsResult> {
  const first = modelsUrl(openAiBaseUrl);
  if (!first) {
    return { ok: false, error: 'Invalid base URL' };
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = (apiKey || '').trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  const allowedHost = first.hostname;
  const seen = new Set<string>();
  const models: OpenRouterCatalogModel[] = [];
  let url: string | null = first.toString();
  const visited = new Set<string>();
  try {
    for (let page = 0; url && page < MAX_CATALOG_PAGES; page += 1) {
      if (visited.has(url)) {
        break;
      }
      visited.add(url);
      const res = await fetchImpl(url, { headers });
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} from ${url}` };
      }
      const body: unknown = await res.json().catch(() => null);
      const parsed = parseOpenRouterModelsPage(body);
      for (const model of parsed.models) {
        if (seen.has(model.id)) {
          continue;
        }
        seen.add(model.id);
        models.push(model);
      }
      url = parsed.next ? resolveOpenRouterNextUrl(url, parsed.next, allowedHost) : null;
    }
    return { ok: true, models };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg || 'Request failed' };
  }
}
