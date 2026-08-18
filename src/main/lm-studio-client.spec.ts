import { describe, expect, it } from 'vitest';
import { effectiveLmStudioContextTokens } from '../shared/lm-studio-ipc';
import { normalizeLmStudioV0Entry, normalizeLmStudioV1Entry } from './lm-studio-client';

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
});
