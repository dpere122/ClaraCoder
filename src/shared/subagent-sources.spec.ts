import { describe, expect, it } from 'vitest';
import { PINNED_LLAMA_SERVER_URL_PROVIDER_ID } from './llm-provider-ids';
import { subagentSource, subagentSources } from './subagent-sources';
import type { LlmProviderConfig } from './types/app-config';

function provider(id: string, kind: string, runCommand?: string, models = 1): LlmProviderConfig {
  return {
    id,
    name: `name of ${id}`,
    provider: kind,
    models: Array.from({ length: models }, (_, n) => ({
      id: `${id}-preset-${n}`,
      model: `${id}-model`,
      optimizationPreset: 'qwen',
      ...(runCommand === undefined ? {} : { llamaCppManaged: { chatRunCommand: runCommand } }),
    })),
  } as unknown as LlmProviderConfig;
}

describe('subagentSource', () => {
  it('describes a source by its Settings id and its connection id', () => {
    expect(subagentSource(provider('lm', 'lmstudio'), 'LM Studio')).toEqual({
      id: 'lm',
      connectionId: 'lm-preset-0',
      label: 'LM Studio',
      provider: 'lmstudio',
      model: 'lm-model',
      preset: 'qwen',
      local: true,
      launchable: false,
    });
  });

  it('calls a local model launchable only when the app has a command to run', () => {
    const launchable = (p: LlmProviderConfig) => subagentSource(p, 'x')?.launchable;
    expect(launchable(provider('gguf', 'llamacpp', 'llama-server -m a.gguf'))).toBe(true);
    expect(launchable(provider('blank', 'llamacpp', '   '))).toBe(false);
    expect(launchable(provider('none', 'llamacpp'))).toBe(false);
    // The pinned server URL row is a llama server the app does not start.
    expect(launchable(provider(PINNED_LLAMA_SERVER_URL_PROVIDER_ID, 'llamacpp', 'llama-server'))).toBe(false);
    expect(launchable(provider('cloud', 'openai', 'llama-server'))).toBe(false);
  });

  it('skips what no role can run on', () => {
    expect(subagentSource(provider('img', 'python-t2i'), 'Images')).toBeNull();
    expect(subagentSource(provider('empty', 'openai', undefined, 0), 'Empty')).toBeNull();
  });
});

describe('subagentSources', () => {
  it('keeps the order given and labels each source', () => {
    const list = subagentSources(
      [provider('b', 'openai'), provider('img', 'python-t2i'), provider('a', 'anthropic')],
      (p) => p.id.toUpperCase(),
    );
    expect(list.map((source) => [source.id, source.label, source.local])).toEqual([
      ['b', 'B', false],
      ['a', 'A', false],
    ]);
  });
});
