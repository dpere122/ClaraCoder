import { describe, it, expect } from 'vitest';
import type { LlmConnectionConfig } from '../../shared';
import { defaultLspServersSettings } from '../../shared/lsp-settings';
import {
  changedLspServerIds,
  chatTemplateReasoningWire,
  embeddingsConfiguredForWire,
  embeddingsEnabledForWire,
  ensureOpenAiV1Base,
  normalizeBindAllHostToLocalhost,
} from './workspace-sync';

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

describe('normalizeBindAllHostToLocalhost', () => {
  it.each([
    ['http://0.0.0.0:8080/v1', 'http://127.0.0.1:8080/v1'],
    ['http://[::]:8080/v1', 'http://127.0.0.1:8080/v1'],
  ])('rewrites the bind address in %s', (raw, expected) => {
    expect(normalizeBindAllHostToLocalhost(raw)).toBe(expected);
  });

  it('leaves a concrete host alone', () => {
    expect(normalizeBindAllHostToLocalhost('http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1');
  });
});

describe('ensureOpenAiV1Base', () => {
  it('appends /v1 when the user pasted a host-only LM Studio URL', () => {
    expect(ensureOpenAiV1Base('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
    expect(ensureOpenAiV1Base('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1');
    expect(ensureOpenAiV1Base('')).toBe('');
  });
});

describe('chatTemplateReasoningWire', () => {
  const caps = { enableThinking: true, reasoningEffortValues: null };

  it('passes the server vision capability through', () => {
    expect(chatTemplateReasoningWire({ ...caps, vision: false })).toEqual({ ...caps, vision: false });
    expect(chatTemplateReasoningWire({ ...caps, vision: true })).toEqual({ ...caps, vision: true });
  });

  it('leaves vision out when the server did not report it', () => {
    expect(chatTemplateReasoningWire(caps)).not.toHaveProperty('vision');
  });
});

describe('embeddingsEnabledForWire', () => {
  // CPU FastEmbed is the primary embedding backend — HTTP embeddings are always disabled.

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
  // CPU FastEmbed is the primary embedding backend — no HTTP embeddings are configured.

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

describe('changedLspServerIds', () => {
  it('names only the servers whose settings changed', () => {
    const before = defaultLspServersSettings();
    const after = defaultLspServersSettings();
    after.typescript.inlayVariableTypes = true;
    after.python.extraPaths = ['src'];
    expect(changedLspServerIds(before, after)).toEqual(['python', 'typescript']);
    expect(changedLspServerIds(after, structuredClone(after))).toEqual([]);
  });

  it('names none on the first sync, when the sidecar runs no servers yet', () => {
    const settings = defaultLspServersSettings();
    settings.gdscript.inlayTypeHints = !settings.gdscript.inlayTypeHints;
    expect(changedLspServerIds(null, settings)).toEqual([]);
  });

  it('adds the servers that read workspace trust when the trusted workspaces changed', () => {
    const before = defaultLspServersSettings();
    expect(changedLspServerIds(before, structuredClone(before), true)).toEqual(['gdscript', 'rust']);

    const after = defaultLspServersSettings();
    after.rust.checkCommand = 'clippy';
    after.python.extraPaths = ['src'];
    expect(changedLspServerIds(before, after, true)).toEqual(['python', 'rust', 'gdscript']);
    expect(changedLspServerIds(null, after, true)).toEqual([]);
  });
});
