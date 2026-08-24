import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectiveLmStudioContextTokens } from '../shared/lm-studio-ipc';
import { lmStudioListModels, normalizeLmStudioV0Entry, normalizeLmStudioV1Entry } from './lm-studio-client';

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
