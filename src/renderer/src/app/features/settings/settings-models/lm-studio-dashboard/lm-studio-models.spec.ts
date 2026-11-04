import { describe, expect, it } from 'vitest';
import {
  formatLmStudioTokens,
  lmStudioContextOptions,
  lmStudioSuggestedProfile,
  lmStudioThinkingOptions,
  lmStudioThinkingPatch,
  lmStudioThinkingValue,
} from './lm-studio-models';

describe('formatLmStudioTokens', () => {
  it('shortens round sizes and leaves the rest exact', () => {
    expect(formatLmStudioTokens(262144)).toBe('256K');
    expect(formatLmStudioTokens(1048576)).toBe('1M');
    expect(formatLmStudioTokens(1500)).toBe((1500).toLocaleString());
  });
});

describe('lmStudioContextOptions', () => {
  it('offers only real sizes: those below the max, then the max itself', () => {
    expect(lmStudioContextOptions(20000).map((o) => o.id)).toEqual(['8192', '16384', '20000']);
    expect(lmStudioContextOptions(20000).at(-1)?.label).toContain('model max');
  });

  it('does not repeat a max that is also a round size', () => {
    expect(lmStudioContextOptions(16384).map((o) => o.id)).toEqual(['8192', '16384']);
  });
});

describe('thinking options', () => {
  const onOff = { reasoningOptions: ['off', 'on'], reasoningDefault: 'on' };
  const levels = { reasoningOptions: ['off', 'low', 'high'], reasoningDefault: 'low' };

  it('offers only what the model reports', () => {
    expect(lmStudioThinkingOptions(onOff).map((o) => o.label)).toEqual(['Off', 'On']);
    expect(lmStudioThinkingOptions(levels).map((o) => o.id)).toEqual(['off', 'low', 'high']);
    expect(lmStudioThinkingOptions(null)).toEqual([]);
  });

  it('shows the model default until something else is saved', () => {
    expect(lmStudioThinkingValue(onOff, 'default', '')).toBe('on');
    expect(lmStudioThinkingValue(levels, 'default', '')).toBe('low');
  });

  it('shows a saved choice', () => {
    expect(lmStudioThinkingValue(onOff, 'off', '')).toBe('off');
    expect(lmStudioThinkingValue(levels, 'on', 'high')).toBe('high');
  });

  it('falls back to the default when the saved effort is not on this model', () => {
    expect(lmStudioThinkingValue(onOff, 'on', 'high' as never)).toBe('on');
  });

  it('saves off as a mode, and levels as an effort', () => {
    expect(lmStudioThinkingPatch('off')).toEqual({ thinkingMode: 'off', reasoningEffort: '' });
    expect(lmStudioThinkingPatch('on')).toEqual({ thinkingMode: 'on', reasoningEffort: '' });
    expect(lmStudioThinkingPatch('high')).toEqual({ thinkingMode: 'on', reasoningEffort: 'high' });
  });
});

describe('lmStudioSuggestedProfile', () => {
  it('matches a profile from the architecture', () => {
    expect(lmStudioSuggestedProfile({ arch: 'qwen35' })).toBe('qwen');
    expect(lmStudioSuggestedProfile({ arch: 'gemma4' })).toBe('gemma');
  });

  it('suggests nothing for other models', () => {
    expect(lmStudioSuggestedProfile({ arch: 'llama' })).toBeNull();
    expect(lmStudioSuggestedProfile(null)).toBeNull();
  });
});
