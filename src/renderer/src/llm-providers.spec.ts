import { describe, expect, it } from 'vitest';
import {
  LLM_REASONING_EFFORT_OPTIONS,
  LLM_THINKING_MODE_OPTIONS,
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  SecretValue,
  findManagedLocalLlamaLocation,
  llmReasoningSelectChange,
  llmReasoningSelectOptions,
  llmReasoningSelectValue,
  patchLlmModelProfile,
  type AppConfig,
  type LlmModelProfile,
  type LlmProviderConfig,
} from '@shared/index';

function profile(overrides: Partial<LlmModelProfile> = {}): LlmModelProfile {
  return {
    id: 'model-a',
    name: 'A',
    model: 'gpt-4o',
    contextWindowTokens: 128_000,
    reasoningEffort: '',
    thinkingMode: 'default',
    samplingPreset: 'provider-default',
    architectureHint: 'auto',
    temperature: 0,
    parallelToolCalls: false,
    optimizationPreset: 'generic',
    maxOutputTokens: 0,
    ...overrides,
  };
}

function providers(): LlmProviderConfig[] {
  return [
    {
      id: 'prov-1',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: '',
      apiKey: SecretValue.of(''),
      models: [profile(), profile({ id: 'model-b', name: 'B', reasoningEffort: 'low' })],
    },
  ];
}

describe('LLM_REASONING_EFFORT_OPTIONS', () => {
  it('matches the Models settings Reasoning dropdown values', () => {
    expect(LLM_REASONING_EFFORT_OPTIONS.map((o) => o.value)).toEqual([
      '',
      'on',
      'off',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(LLM_REASONING_EFFORT_OPTIONS.find((o) => o.value === '')?.label).toBe('Default');
    expect(LLM_REASONING_EFFORT_OPTIONS.find((o) => o.value === 'on')?.label).toBe('On (medium)');
    expect(LLM_REASONING_EFFORT_OPTIONS.find((o) => o.value === 'off')?.label).toBe('Off (none)');
  });
});

describe('llmReasoningSelectOptions', () => {
  it('uses thinking Default/On/Off for the Gemma preset', () => {
    expect(llmReasoningSelectOptions('gemma')).toBe(LLM_THINKING_MODE_OPTIONS);
    expect(llmReasoningSelectOptions('gemma').map((o) => o.value)).toEqual(['default', 'on', 'off']);
  });

  it('uses the full reasoning effort list for generic', () => {
    expect(llmReasoningSelectOptions('generic')).toBe(LLM_REASONING_EFFORT_OPTIONS);
    expect(llmReasoningSelectOptions(undefined)).toBe(LLM_REASONING_EFFORT_OPTIONS);
  });

  it('uses low/medium/xhigh for the Qwen preset', () => {
    expect(llmReasoningSelectOptions('qwen').map((o) => o.value)).toEqual(['', 'low', 'medium', 'xhigh']);
  });
});

describe('llmReasoningSelectValue', () => {
  it('reads thinkingMode on Gemma and reasoningEffort otherwise', () => {
    expect(
      llmReasoningSelectValue(profile({ optimizationPreset: 'gemma', thinkingMode: 'off', reasoningEffort: 'high' })),
    ).toBe('off');
    expect(llmReasoningSelectValue(profile({ optimizationPreset: 'qwen', reasoningEffort: 'low' }))).toBe('low');
    expect(llmReasoningSelectValue(profile({ optimizationPreset: 'generic' }))).toBe('');
  });
});

describe('llmReasoningSelectChange', () => {
  it('writes thinkingMode for Gemma and reasoningEffort for generic/Qwen', () => {
    expect(llmReasoningSelectChange('gemma', 'on')).toEqual({ field: 'thinkingMode', value: 'on' });
    expect(llmReasoningSelectChange('qwen', 'high')).toEqual({ field: 'reasoningEffort', value: 'high' });
    expect(llmReasoningSelectChange('generic', '')).toEqual({ field: 'reasoningEffort', value: '' });
  });
});

describe('patchLlmModelProfile', () => {
  it('patches reasoningEffort on the matching model only', () => {
    const original = providers();
    const next = patchLlmModelProfile(original, 'model-a', { reasoningEffort: 'high' });
    expect(next[0].models[0].reasoningEffort).toBe('high');
    expect(next[0].models[1].reasoningEffort).toBe('low');
    expect(original[0].models[0].reasoningEffort).toBe('');
  });

  it('returns the same array when the model id is unknown', () => {
    const original = providers();
    expect(patchLlmModelProfile(original, 'missing', { reasoningEffort: 'high' })).toBe(original);
  });

  it('deletes a field when the patch value is undefined', () => {
    const original = providers();
    const next = patchLlmModelProfile(original, 'model-b', { reasoningEffort: undefined });
    expect(next[0].models[1].reasoningEffort).toBeUndefined();
    expect(next[0].models[0].reasoningEffort).toBe('');
  });
});

describe('findManagedLocalLlamaLocation', () => {
  function llamacppProvider(id: string, modelId: string): LlmProviderConfig {
    return {
      id,
      name: 'llama',
      provider: 'llamacpp',
      baseUrl: '',
      apiKey: SecretValue.of(''),
      models: [profile({ id: modelId, name: 'Local', model: 'local' })],
    };
  }

  it('returns the active managed local llamacpp source', () => {
    const cfg = {
      activeLlmModelId: 'local-1',
      llmProviders: [llamacppProvider(PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID, 'local-1')],
    } as unknown as AppConfig;
    expect(findManagedLocalLlamaLocation(cfg)?.model.id).toBe('local-1');
  });

  it('returns a user-added llamacpp source (not only the pinned local row)', () => {
    const cfg = {
      activeLlmModelId: 'custom-1',
      llmProviders: [llamacppProvider('my-llama', 'custom-1')],
    } as unknown as AppConfig;
    expect(findManagedLocalLlamaLocation(cfg)?.provider.id).toBe('my-llama');
  });

  it('excludes the pinned URL-only llama-server row', () => {
    const cfg = {
      activeLlmModelId: 'url-1',
      llmProviders: [llamacppProvider(PINNED_LLAMA_SERVER_URL_PROVIDER_ID, 'url-1')],
    } as unknown as AppConfig;
    expect(findManagedLocalLlamaLocation(cfg)).toBeNull();
  });

  it('returns null when the active source is not llamacpp', () => {
    const cfg = {
      activeLlmModelId: 'model-a',
      llmProviders: providers(),
    } as unknown as AppConfig;
    expect(findManagedLocalLlamaLocation(cfg)).toBeNull();
  });
});
