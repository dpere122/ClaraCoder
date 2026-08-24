import type { LmStudioListModelsResult, LmStudioModelCard, LmStudioMutationResult } from '../shared/lm-studio-ipc';
import { coerceLmStudioContextTokens } from '../shared/lm-studio-ipc';
import { lmStudioOpenAiBaseUrlToRestOrigin } from '../shared/lm-studio-url';

const LIST_TIMEOUT_MS = 15_000;

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = (apiKey || '').trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function fetchErrorMessage(e: unknown): string {
  if (!(e instanceof Error)) {
    return String(e);
  }
  if (e.name === 'AbortError') {
    return 'LM Studio did not respond in time (is the server running?)';
  }
  const cause = e.cause instanceof Error ? e.cause.message : '';
  if (cause && !e.message.includes(cause)) {
    return `${e.message} (${cause})`;
  }
  return e.message;
}

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
}

function instanceContextLength(inst: Record<string, unknown> | null): number {
  if (!inst) {
    return 0;
  }
  const cfg = asRecord(inst.config) ?? inst;
  return (
    coerceLmStudioContextTokens(cfg['context_length']) ||
    coerceLmStudioContextTokens(cfg['contextLength']) ||
    coerceLmStudioContextTokens(inst['loaded_context_length']) ||
    coerceLmStudioContextTokens(inst['context_length'])
  );
}

function loadedInstanceId(inst: Record<string, unknown> | null, fallback: string): string {
  if (!inst) {
    return fallback;
  }
  const raw = String(inst.id ?? inst.instance_id ?? inst.instanceId ?? fallback).trim();
  return raw || fallback;
}

export function normalizeLmStudioV1Entry(raw: unknown): LmStudioModelCard | null {
  const m = asRecord(raw);
  if (!m) {
    return null;
  }
  const id = String(m.key ?? m.id ?? '').trim();
  if (!id) {
    return null;
  }
  const loadedInstances = Array.isArray(m.loaded_instances) ? m.loaded_instances : [];
  const loaded = loadedInstances.length > 0;
  const firstInst = loaded ? asRecord(loadedInstances[0]) : null;
  const quant = asRecord(m.quantization);
  const quantName = quant && typeof quant.name === 'string' ? quant.name : '';
  const instanceId = loaded ? loadedInstanceId(firstInst, id) : undefined;
  const maxCtx = coerceLmStudioContextTokens(m.max_context_length);
  const loadedCtx = loaded ? instanceContextLength(firstInst) : 0;
  return {
    id,
    type: String(m.type ?? ''),
    publisher: String(m.publisher ?? ''),
    arch: String(m.architecture ?? m.arch ?? ''),
    compatibility_type: String(m.format ?? m.compatibility_type ?? ''),
    quantization: quantName,
    state: loaded ? 'loaded' : 'not-loaded',
    max_context_length: maxCtx,
    loaded_context_length: loadedCtx,
    instanceId,
  };
}

export function normalizeLmStudioV0Entry(raw: unknown): LmStudioModelCard | null {
  const m = asRecord(raw);
  if (!m) {
    return null;
  }
  const id = String(m.id ?? '').trim();
  if (!id) {
    return null;
  }
  const state = String(m.state ?? 'unknown');
  const loaded = state === 'loaded' || state === 'loading';
  return {
    id,
    type: String(m.type ?? ''),
    publisher: String(m.publisher ?? ''),
    arch: String(m.arch ?? ''),
    compatibility_type: String(m.compatibility_type ?? ''),
    quantization: String(m.quantization ?? ''),
    state,
    max_context_length: coerceLmStudioContextTokens(m.max_context_length),
    loaded_context_length: loaded ? coerceLmStudioContextTokens(m.loaded_context_length) : 0,
    instanceId: loaded ? id : undefined,
  };
}

type ProbeResult =
  | { kind: 'ok'; models: LmStudioModelCard[] }
  | { kind: 'skip' }
  | { kind: 'fail'; error: string };

export async function lmStudioListModels(baseUrl: string, apiKey: string): Promise<LmStudioListModelsResult> {
  const origin = lmStudioOpenAiBaseUrlToRestOrigin(baseUrl);
  if (!origin) {
    return { ok: false, error: 'Invalid base URL' };
  }
  const headers = authHeaders(apiKey);

  const tryV1 = async (): Promise<ProbeResult> => {
    const url = `${origin}/api/v1/models`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers }, LIST_TIMEOUT_MS);
    } catch (e) {
      return { kind: 'fail', error: fetchErrorMessage(e) || 'Request failed' };
    }
    if (res.status === 404) {
      return { kind: 'skip' };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { kind: 'fail', error: t.trim() || `HTTP ${res.status} from ${url}` };
    }
    const body = asRecord(await res.json().catch(() => null));
    if (!body || !Array.isArray(body.models)) {
      return { kind: 'skip' };
    }
    const models = body.models.map(normalizeLmStudioV1Entry).filter((x): x is LmStudioModelCard => x != null);
    return { kind: 'ok', models };
  };

  const tryV0 = async (): Promise<ProbeResult> => {
    const url = `${origin}/api/v0/models`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers }, LIST_TIMEOUT_MS);
    } catch (e) {
      return { kind: 'fail', error: fetchErrorMessage(e) || 'Request failed' };
    }
    if (res.status === 404) {
      return { kind: 'skip' };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { kind: 'fail', error: t.trim() || `HTTP ${res.status} from ${url}` };
    }
    const body = asRecord(await res.json().catch(() => null));
    if (!body || !Array.isArray(body.data)) {
      return { kind: 'skip' };
    }
    const models = body.data.map(normalizeLmStudioV0Entry).filter((x): x is LmStudioModelCard => x != null);
    return { kind: 'ok', models };
  };

  try {
    const v1 = await tryV1();
    if (v1.kind === 'ok') {
      return { ok: true, origin, source: 'v1', models: v1.models };
    }
    if (v1.kind === 'fail' && /did not respond|ECONNREFUSED|ENOTFOUND|ENETUNREACH/i.test(v1.error)) {
      return { ok: false, error: v1.error };
    }
    const v0 = await tryV0();
    if (v0.kind === 'ok') {
      return { ok: true, origin, source: 'v0', models: v0.models };
    }
    const error =
      (v0.kind === 'fail' ? v0.error : '') ||
      (v1.kind === 'fail' ? v1.error : '') ||
      'LM Studio did not return models (check server is running and URL).';
    return { ok: false, error };
  } catch (e) {
    return { ok: false, error: fetchErrorMessage(e) || 'Request failed' };
  }
}

export async function lmStudioLoadModel(
  origin: string,
  modelKey: string,
  apiKey: string,
): Promise<LmStudioMutationResult> {
  const headers = { ...authHeaders(apiKey), 'Content-Type': 'application/json' };
  try {
    const res = await fetch(`${origin}/api/v1/models/load`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelKey }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: t || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: fetchErrorMessage(e) || 'Load failed' };
  }
}

export async function lmStudioUnloadModel(
  origin: string,
  instanceId: string,
  apiKey: string,
): Promise<LmStudioMutationResult> {
  const headers = { ...authHeaders(apiKey), 'Content-Type': 'application/json' };
  try {
    const res = await fetch(`${origin}/api/v1/models/unload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ instance_id: instanceId }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: t || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: fetchErrorMessage(e) || 'Unload failed' };
  }
}
