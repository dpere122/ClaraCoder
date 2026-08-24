import { describe, it, expect } from 'vitest';
import type { LlmConnectionConfig } from '../../shared';
import { embeddingsConfiguredForWire, embeddingsEnabledForWire, ensureOpenAiV1Base } from './workspace-sync';

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
    ...overrides,
  };
}

describe('ensureOpenAiV1Base', () => {
  it('appends /v1 when the user pasted a host-only LM Studio URL', () => {
    expect(ensureOpenAiV1Base('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
    expect(ensureOpenAiV1Base('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1');
    expect(ensureOpenAiV1Base('')).toBe('');
  });
});

describe('embeddingsEnabledForWire', () => {
  // CPU Nomic is the primary embedding backend — HTTP embeddings are always disabled.

  it('returns false for openai', () => {
    expect(
      embeddingsEnabledForWire(
        llamacppConn({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }),
        undefined,
      ),
    ).toBe(false);
  });

  it('returns false for lmstudio', () => {
    expect(embeddingsEnabledForWire(llamacppConn({ provider: 'lmstudio' }), undefined)).toBe(false);
  });

  it('returns false for chat-only llama URL preset', () => {
    expect(embeddingsEnabledForWire(llamacppConn(), undefined)).toBe(false);
  });

  it('returns false for managed llama with embeddingRunCommand', () => {
    expect(
      embeddingsEnabledForWire(
        llamacppConn({
          llamaCppManaged: { chatRunCommand: 'llama-server {{PORT}}', embeddingRunCommand: 'llama-server --embedding {{PORT}}' },
        }),
        { baseUrl: 'http://127.0.0.1:8080/v1', embeddingsBaseUrl: 'http://127.0.0.1:8081/v1' },
      ),
    ).toBe(false);
  });
});

describe('embeddingsConfiguredForWire', () => {
  // CPU Nomic is the primary embedding backend — no HTTP embeddings are configured.

  it('returns false for openai', () => {
    expect(embeddingsConfiguredForWire(llamacppConn({ provider: 'openai' }))).toBe(false);
  });

  it('returns false for chat-only llama', () => {
    expect(embeddingsConfiguredForWire(llamacppConn())).toBe(false);
  });

  it('returns false for lmstudio with embeddingsModel', () => {
    expect(
      embeddingsConfiguredForWire(llamacppConn({ provider: 'lmstudio', embeddingsModel: 'nomic-embed-text' })),
    ).toBe(false);
  });

  it('returns false when a managed embedding command is set', () => {
    expect(
      embeddingsConfiguredForWire(
        llamacppConn({
          llamaCppManaged: {
            chatRunCommand: 'llama-server {{PORT}}',
            embeddingRunCommand: 'llama-server --embedding {{PORT}}',
          },
        }),
      ),
    ).toBe(false);
  });

  it('returns false when embeddingsBaseUrl is set', () => {
    expect(
      embeddingsConfiguredForWire(llamacppConn({ embeddingsBaseUrl: 'http://127.0.0.1:8081/v1' })),
    ).toBe(false);
  });
});
