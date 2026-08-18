import type { LmStudioListModelsResult, LmStudioModelCard, LmStudioMutationResult } from '../shared/lm-studio-ipc';
import { coerceLmStudioContextTokens } from '../shared/lm-studio-ipc';
import { lmStudioOpenAiBaseUrlToRestOrigin } from '../shared/lm-studio-url';

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
  const instanceId = firstInst ? String(firstInst.id ?? id).trim() || id : loaded ? id : undefined;
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
    instanceId: loaded ? instanceId : undefined,
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

export async function lmStudioListModels(baseUrl: string, apiKey: string): Promise<LmStudioListModelsResult> {
  const origin = lmStudioOpenAiBaseUrlToRestOrigin(baseUrl);
  if (!origin) {
    return { ok: false, error: 'Invalid base URL' };
  }
  const headers = authHeaders(apiKey);

  const tryV1 = async (): Promise<LmStudioModelCard[] | null> => {
    const res = await fetch(`${origin}/api/v1/models`, { headers });
    if (!res.ok) {
      return null;
    }
    const body = asRecord(await res.json().catch(() => null));
    if (!body) {
      return null;
    }
    const list = Array.isArray(body.models) ? body.models : [];
    const models = list.map(normalizeLmStudioV1Entry).filter((x): x is LmStudioModelCard => x != null);
    return models;
  };

  const tryV0 = async (): Promise<LmStudioModelCard[] | null> => {
    const res = await fetch(`${origin}/api/v0/models`, { headers });
    if (!res.ok) {
      return null;
    }
    const body = asRecord(await res.json().catch(() => null));
    if (!body) {
      return null;
    }
    const list = Array.isArray(body.data) ? body.data : [];
    const models = list.map(normalizeLmStudioV0Entry).filter((x): x is LmStudioModelCard => x != null);
    return models;
  };

  try {
    const v1 = await tryV1();
    if (v1) {
      return { ok: true, origin, source: 'v1', models: v1 };
    }
    const v0 = await tryV0();
    if (v0) {
      return { ok: true, origin, source: 'v0', models: v0 };
    }
    return { ok: false, error: 'LM Studio did not return models (check server is running and URL).' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg || 'Request failed' };
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
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg || 'Load failed' };
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
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg || 'Unload failed' };
  }
}
