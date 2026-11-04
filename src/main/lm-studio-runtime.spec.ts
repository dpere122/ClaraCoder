import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmConnectionConfig } from '../shared';
import { SecretValue } from '../shared/types/app-config';
import { refreshLmStudioReasoningForConnection, ensureLmStudioModelLoaded } from './lm-studio-runtime';

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: {}, BrowserWindow: {} }));
vi.mock('./llama-server-manager', () => ({ getLlamaManagedRuntimeOverrides: () => ({}) }));
vi.mock('./python/workspace-sync', () => ({ syncRuntimeConfigToPython: vi.fn() }));
vi.mock('./config/load-save', () => ({ loadConfig: vi.fn() }));

function connection(over: Partial<LlmConnectionConfig> = {}): LlmConnectionConfig {
  return {
    id: 'm1',
    name: 'Gemma',
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: SecretValue.of('lm-studio'),
    model: 'gemma',
    ...over,
  } as LlmConnectionConfig;
}

/** Fake server whose one model is loaded or not; returns the load bodies it received. */
function server(models: Record<string, unknown>[], loadStatus = 200) {
  const loads: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/models')) {
        return new Response(JSON.stringify({ models }), { status: 200 });
      }
      loads.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: loadStatus });
    }),
  );
  return loads;
}

const unloaded = { key: 'gemma', type: 'llm', max_context_length: 262144, loaded_instances: [] };
const loaded = { ...unloaded, loaded_instances: [{ id: 'gemma', config: { context_length: 8192 } }] };

describe('refreshLmStudioReasoningForConnection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports what a v1 server says about the model', async () => {
    server([{ ...unloaded, capabilities: { reasoning: { allowed_options: ['off', 'on'], default: 'on' } } }]);
    expect(await refreshLmStudioReasoningForConnection(connection())).toMatchObject({ enableThinking: true });
  });

  it('treats a v1 model with no reasoning block as having no controls', async () => {
    server([{ ...unloaded, capabilities: {} }]);
    expect(await refreshLmStudioReasoningForConnection(connection())).toEqual({ enableThinking: false, reasoningEffortValues: null });
  });

  it('knows nothing about a model on a v0 server, so generic controls stay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/v1/models')
          ? new Response('', { status: 404 })
          : new Response(JSON.stringify({ data: [{ id: 'gemma', type: 'llm', state: 'loaded' }] }), { status: 200 }),
      ),
    );
    expect(await refreshLmStudioReasoningForConnection(connection())).toBeUndefined();
  });
});

describe('ensureLmStudioModelLoaded', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads an unloaded model with the saved settings', async () => {
    const loads = server([unloaded]);
    const settings = { contextLength: 65536, parallel: 2, evalBatchSize: 512, flashAttention: false, offloadKvCacheToGpu: true, autoLoad: true, idleTtlSeconds: 60 };
    expect(await ensureLmStudioModelLoaded(connection({ lmStudio: settings }))).toBe(true);
    expect(loads).toEqual([{ model: 'gemma', context_length: 65536, parallel: 2, eval_batch_size: 512, flash_attention: false, offload_kv_cache_to_gpu: true }]);
  });

  it('uses the defaults when nothing was saved, and never asks above the model max', async () => {
    const loads = server([{ ...unloaded, max_context_length: 2048 }]);
    expect(await ensureLmStudioModelLoaded(connection())).toBe(true);
    expect(loads[0]).toMatchObject({ context_length: 2048, parallel: 4 });
  });

  it('leaves a loaded model alone', async () => {
    const loads = server([loaded]);
    expect(await ensureLmStudioModelLoaded(connection())).toBe(false);
    expect(loads).toEqual([]);
  });

  it('leaves loading to LM Studio when auto-load is off', async () => {
    const loads = server([unloaded]);
    expect(await ensureLmStudioModelLoaded(connection({ lmStudio: { autoLoad: false } as never }))).toBe(false);
    expect(loads).toEqual([]);
  });

  it('does not load a model the server does not list, or for another provider', async () => {
    const loads = server([unloaded]);
    expect(await ensureLmStudioModelLoaded(connection({ model: 'other' }))).toBe(false);
    expect(await ensureLmStudioModelLoaded(connection({ provider: 'openai' }))).toBe(false);
    expect(loads).toEqual([]);
  });

  it('lets the turn go ahead when the load or the server fails', async () => {
    server([unloaded], 500);
    expect(await ensureLmStudioModelLoaded(connection())).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }))));
    expect(await ensureLmStudioModelLoaded(connection())).toBe(false);
  });
});
