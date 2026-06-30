import { describe, it, expect } from 'vitest';
import type { LlmConnectionConfig } from '../../shared';
import { embeddingsEnabledForWire } from './workspace-sync';

function llamacppConn(overrides: Partial<LlmConnectionConfig> = {}): LlmConnectionConfig {
  return {
    id: 'preset-1',
    name: 'Test',
    provider: 'llamacpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    model: 'chat.gguf',
    contextWindowTokens: 8192,
    thinkingMode: 'default',
    samplingPreset: 'provider-default',
    architectureHint: 'auto',
    temperature: 0,
    parallelToolCalls: false,
    optimizationPreset: 'generic',
    maxOutputTokens: 0,
    planRetryAttemptsCount: 2,
    ...overrides,
  };
}

describe('embeddingsEnabledForWire', () => {
  it('returns true for openai regardless of embeddingsModel', () => {
    expect(
      embeddingsEnabledForWire(
        llamacppConn({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }),
        undefined,
      ),
    ).toBe(true);
  });

  it('returns false for lmstudio without embeddingsModel', () => {
    expect(embeddingsEnabledForWire(llamacppConn({ provider: 'lmstudio' }), undefined)).toBe(false);
  });

  it('returns true for lmstudio with embeddingsModel', () => {
    expect(
      embeddingsEnabledForWire(
        llamacppConn({ provider: 'lmstudio', embeddingsModel: 'nomic-embed-text' }),
        undefined,
      ),
    ).toBe(true);
  });

  it('returns false for chat-only llama URL preset', () => {
    expect(embeddingsEnabledForWire(llamacppConn(), undefined)).toBe(false);
  });

  it('returns true for llama URL preset with embeddingsModel and chat URL', () => {
    expect(
      embeddingsEnabledForWire(llamacppConn({ embeddingsModel: 'nomic-embed-text' }), undefined),
    ).toBe(true);
  });

  it('returns true for llama URL preset with separate embeddingsBaseUrl', () => {
    expect(
      embeddingsEnabledForWire(
        llamacppConn({ embeddingsBaseUrl: 'http://127.0.0.1:8081/v1' }),
        undefined,
      ),
    ).toBe(true);
  });

  it('returns false for managed llama with embeddingRunCommand but no running embed URL', () => {
    expect(
      embeddingsEnabledForWire(
        llamacppConn({
          llamaCppManaged: { chatRunCommand: 'llama-server {{PORT}}', embeddingRunCommand: 'llama-server --embedding {{PORT}}' },
          embeddingsBaseUrl: 'http://127.0.0.1:8081/v1',
        }),
        { baseUrl: 'http://127.0.0.1:8080/v1', embeddingsBaseUrl: '' },
      ),
    ).toBe(false);
  });

  it('returns true for managed llama when override embed URL is known', () => {
    expect(
      embeddingsEnabledForWire(
        llamacppConn({
          llamaCppManaged: { chatRunCommand: 'llama-server {{PORT}}', embeddingRunCommand: 'llama-server --embedding {{PORT}}' },
        }),
        { baseUrl: 'http://127.0.0.1:8080/v1', embeddingsBaseUrl: 'http://127.0.0.1:8081/v1' },
      ),
    ).toBe(true);
  });
});
