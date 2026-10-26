import { describe, expect, it } from 'vitest';
import { managedLlamaModelLabel, managedLlamaSourceDisplayName } from './managed-llama-model-pick';
import type { LlmModelProfile, LlmProviderConfig } from './types/app-config';

function managedSource(chatRunCommand: string, customName?: string): LlmProviderConfig {
  return {
    id: 'src-1',
    name: 'Llama Server 1',
    ...(customName !== undefined ? { customName } : {}),
    provider: 'llamacpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: {} as LlmProviderConfig['apiKey'],
    models: [{ id: 'm-1', llamaCppManaged: { chatRunCommand } } as LlmModelProfile],
  };
}

const HF_CMD = 'llama-server --port {PORT} -hf org/model:Q4_0';

describe('managedLlamaSourceDisplayName', () => {
  it('mirrors the selected model when no custom name is set', () => {
    expect(managedLlamaSourceDisplayName(managedSource(HF_CMD), [])).toBe('org/model:Q4_0');
  });

  it('falls back to the stored name when no model is selected', () => {
    expect(managedLlamaSourceDisplayName(managedSource(''), [])).toBe('Llama Server 1');
  });

  it('prefers a custom name over the model label', () => {
    expect(managedLlamaSourceDisplayName(managedSource(HF_CMD, '  My coder  '), [])).toBe('My coder');
  });

  it('ignores a blank custom name', () => {
    expect(managedLlamaSourceDisplayName(managedSource(HF_CMD, '   '), [])).toBe('org/model:Q4_0');
  });
});

describe('managedLlamaModelLabel', () => {
  it('ignores the custom name', () => {
    expect(managedLlamaModelLabel(managedSource(HF_CMD, 'My coder'), [])).toBe('org/model:Q4_0');
  });
});
