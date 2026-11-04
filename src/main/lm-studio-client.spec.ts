import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectiveLmStudioContextTokens, lmStudioReasoningCaps, normalizeLmStudioSettings, type LmStudioLoadOptions } from '../shared/lm-studio-ipc';
import {
  lmStudioHttpError,
  lmStudioListModels,
  lmStudioLoadModel,
  normalizeLmStudioV0Entry,
  normalizeLmStudioV1Entry,
} from './lm-studio-client';

describe('normalizeLmStudioV0Entry', () => {
  it('reads loaded_context_length when the model is loaded', () => {
    const card = normalizeLmStudioV0Entry({
      id: 'qwen2.5-7b',
      state: 'loaded',
      max_context_length: 32768,
      loaded_context_length: 8192,
    });
    expect(card?.max_context_length).toBe(32768);
    expect(card?.loaded_context_length).toBe(8192);
    expect(effectiveLmStudioContextTokens(card!)).toBe(8192);
  });

  it('leaves loaded_context_length at 0 when unloaded', () => {
    const card = normalizeLmStudioV0Entry({
      id: 'qwen2.5-7b',
      state: 'not-loaded',
      max_context_length: 32768,
      loaded_context_length: 8192,
    });
    expect(card?.loaded_context_length).toBe(0);
    expect(effectiveLmStudioContextTokens(card!)).toBe(32768);
  });
});

describe('normalizeLmStudioV1Entry', () => {
  it('reads context_length from the first loaded instance config', () => {
    const card = normalizeLmStudioV1Entry({
      key: 'google/gemma-4-26b-a4b',
      max_context_length: 131072,
      loaded_instances: [{ id: 'inst-1', config: { context_length: 4096 } }],
    });
    expect(card?.id).toBe('google/gemma-4-26b-a4b');
    expect(card?.state).toBe('loaded');
    expect(card?.loaded_context_length).toBe(4096);
    expect(effectiveLmStudioContextTokens(card!)).toBe(4096);
  });

  it('uses max when there are no loaded instances', () => {
    const card = normalizeLmStudioV1Entry({
      key: 'deepseek-r1',
      max_context_length: 131072,
      loaded_instances: [],
    });
    expect(card?.state).toBe('not-loaded');
    expect(card?.loaded_context_length).toBe(0);
    expect(effectiveLmStudioContextTokens(card!)).toBe(131072);
  });

  it('reads instance_id when id is absent', () => {
    const card = normalizeLmStudioV1Entry({
      key: 'openai/gpt-oss-20b',
      loaded_instances: [{ instance_id: 'openai/gpt-oss-20b', config: { context_length: 16384 } }],
    });
    expect(card?.instanceId).toBe('openai/gpt-oss-20b');
    expect(card?.loaded_context_length).toBe(16384);
  });
});

describe('lmStudioListModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to v0 when v1 returns 200 without a models array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'should-not-use' }] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            data: [{ id: 'qwen2.5-7b', state: 'loaded', max_context_length: 32768, loaded_context_length: 4096 }],
          }),
          { status: 200 },
        );
      }),
    );
    const res = await lmStudioListModels('http://127.0.0.1:1234/v1', '');
    expect(res).toEqual(
      expect.objectContaining({
        ok: true,
        source: 'v0',
        models: [expect.objectContaining({ id: 'qwen2.5-7b', loaded_context_length: 4096 })],
      }),
    );
  });

  it('surfaces HTTP 401 instead of a generic empty-list message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );
    const res = await lmStudioListModels('http://127.0.0.1:1234/v1', '');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/401|unauthorized/i);
    }
  });

  it('accepts an empty v1 models list as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })),
    );
    const res = await lmStudioListModels('http://127.0.0.1:1234/v1', 'lm-studio');
    expect(res).toEqual(expect.objectContaining({ ok: true, source: 'v1', models: [] }));
  });
});

describe('normalizeLmStudioV1Entry dashboard fields', () => {
  it('reads the display name, size and capabilities', () => {
    const card = normalizeLmStudioV1Entry({
      key: 'hash-1',
      display_name: 'Gemma 4',
      size_bytes: 1024,
      capabilities: { vision: true, trained_for_tool_use: false, reasoning: { allowed_options: ['off', 'on'], default: 'on' } },
      loaded_instances: [],
    });
    expect(card).toMatchObject({ displayName: 'Gemma 4', sizeBytes: 1024, vision: true, toolUse: false, reasoningOptions: ['off', 'on'], reasoningDefault: 'on' });
    expect(card?.runningConfig).toBeUndefined();
  });

  it('leaves them unset when LM Studio omits them', () => {
    const card = normalizeLmStudioV1Entry({ key: 'embed', loaded_instances: [] });
    expect(card).toMatchObject({ displayName: undefined, sizeBytes: undefined, toolUse: undefined, vision: undefined, reasoningOptions: undefined });
  });

  it('reads how a running instance was loaded', () => {
    const card = normalizeLmStudioV1Entry({
      key: 'm',
      loaded_instances: [{ id: 'm', config: { context_length: 8192, parallel: 2, eval_batch_size: 256, flash_attention: false, offload_kv_cache_to_gpu: true } }],
    });
    expect(card?.runningConfig).toEqual({ contextLength: 8192, parallel: 2, evalBatchSize: 256, flashAttention: false, offloadKvCacheToGpu: true });
  });
});

describe('lmStudioHttpError', () => {
  it('points at the token on an auth failure', () => {
    expect(lmStudioHttpError(401, '{"error":"nope"}')).toContain('API token');
    expect(lmStudioHttpError(403, '')).toContain('HTTP 403');
  });

  it('unwraps a JSON error message and falls back to the raw body or status', () => {
    expect(lmStudioHttpError(500, '{"error":{"message":"Out of memory"}}')).toBe('Out of memory');
    expect(lmStudioHttpError(500, '{"error":"Out of memory"}')).toBe('Out of memory');
    expect(lmStudioHttpError(500, 'plain')).toBe('plain');
    expect(lmStudioHttpError(500, '', 'http://x/y')).toBe('HTTP 500 from http://x/y');
  });
});

describe('lmStudioLoadModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const loadBody = async (options?: LmStudioLoadOptions) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await lmStudioLoadModel('http://x', 'm', '', options);
    return JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  };

  it('sends only the options that are set, under the names LM Studio uses', async () => {
    expect(await loadBody({ contextLength: 32768, flashAttention: false })).toEqual({ model: 'm', context_length: 32768, flash_attention: false });
    expect(await loadBody({ parallel: 2, evalBatchSize: 512, offloadKvCacheToGpu: true })).toEqual({ model: 'm', parallel: 2, eval_batch_size: 512, offload_kv_cache_to_gpu: true });
    expect(await loadBody()).toEqual({ model: 'm' });
  });
});

describe('lmStudioReasoningCaps', () => {
  it('offers a thinking toggle only when the model can turn it off', () => {
    expect(lmStudioReasoningCaps({ reasoningOptions: ['off', 'on'] })).toEqual({ enableThinking: true, reasoningEffortValues: null });
    expect(lmStudioReasoningCaps({ reasoningOptions: ['on'] }).enableThinking).toBe(false);
    expect(lmStudioReasoningCaps({}).enableThinking).toBe(false);
  });

  it('lists effort levels only when the model reports them', () => {
    expect(lmStudioReasoningCaps({ reasoningOptions: ['off', 'low', 'high'] }).reasoningEffortValues).toEqual(['low', 'high']);
  });
});

describe('normalizeLmStudioSettings', () => {
  it('fills in the defaults', () => {
    expect(normalizeLmStudioSettings(undefined)).toMatchObject({ contextLength: 32768, parallel: 4, autoLoad: true, flashAttention: true });
  });

  it('keeps valid values and replaces invalid ones', () => {
    const s = normalizeLmStudioSettings({ contextLength: 8192.9, parallel: 0, flashAttention: false, autoLoad: 'yes', idleTtlSeconds: 300 });
    expect(s).toMatchObject({ contextLength: 8192, parallel: 4, flashAttention: false, autoLoad: true, idleTtlSeconds: 300 });
  });
});
