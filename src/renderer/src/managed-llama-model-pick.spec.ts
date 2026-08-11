import {
  buildManagedLlamaChatCommand,
  formatReadyDefaultsSummary,
  hubCacheFolderToHfId,
  inferOptimizationPresetFromModelHint,
  optimizationPresetDefaultsPatch,
  parseManagedLlamaModelSelection,
  suggestContextWindowTokens,
  syncContextFlagInManagedChatCommand,
} from '@shared/index';

describe('hubCacheFolderToHfId', () => {
  it('converts models--org--repo folder names', () => {
    expect(hubCacheFolderToHfId('models--Qwen--Qwen2.5-7B-Instruct-GGUF')).toBe(
      'Qwen/Qwen2.5-7B-Instruct-GGUF',
    );
    expect(hubCacheFolderToHfId('/cache/models--org--name')).toBe('org/name');
  });

  it('returns null for plain filenames', () => {
    expect(hubCacheFolderToHfId('model.gguf')).toBeNull();
  });
});

describe('inferOptimizationPresetFromModelHint', () => {
  it('infers qwen and gemma', () => {
    expect(inferOptimizationPresetFromModelHint('Qwen2.5-27B-Q4_K_M.gguf')).toBe('qwen');
    expect(inferOptimizationPresetFromModelHint('google/gemma-3-12b')).toBe('gemma');
    expect(inferOptimizationPresetFromModelHint('llama-3.1-8b')).toBe('generic');
  });
});

describe('buildManagedLlamaChatCommand', () => {
  it('builds a GGUF -m command with context', () => {
    const cmd = buildManagedLlamaChatCommand(
      { kind: 'gguf', absolutePath: '/models/a.gguf' },
      32_768,
      'posix',
    );
    expect(cmd).toContain('llama-server');
    expect(cmd).toContain('{{PORT}}');
    expect(cmd).toContain('-m /models/a.gguf');
    expect(cmd).toContain('-c 32768');
    expect(cmd).not.toContain('--ctx-checkpoints');
    expect(cmd).not.toContain('--checkpoint-every-n-tokens');
  });

  it('builds an -hf command from hub repo folder', () => {
    const cmd = buildManagedLlamaChatCommand(
      {
        kind: 'hubRepo',
        absolutePath: '/cache/models--Qwen--Qwen2.5-7B-Instruct-GGUF',
        folderName: 'models--Qwen--Qwen2.5-7B-Instruct-GGUF',
      },
      16_384,
      'posix',
    );
    expect(cmd).toContain('-hf Qwen/Qwen2.5-7B-Instruct-GGUF');
    expect(cmd).toContain('-c 16384');
  });
});

describe('parseManagedLlamaModelSelection', () => {
  it('parses -m and -hf', () => {
    expect(parseManagedLlamaModelSelection('llama-server --port {{PORT}} -m /x.gguf -c 8')).toEqual({
      kind: 'gguf',
      absolutePath: '/x.gguf',
    });
    expect(parseManagedLlamaModelSelection('llama-server -hf org/model:Q4_0 --port {{PORT}}')).toEqual({
      kind: 'hf',
      hfId: 'org/model:Q4_0',
    });
  });
});

describe('syncContextFlagInManagedChatCommand', () => {
  it('updates existing -c', () => {
    expect(syncContextFlagInManagedChatCommand('llama-server -c 8192 --port {{PORT}}', 16384, 'posix')).toBe(
      'llama-server -c 16384 --port {{PORT}}',
    );
  });

  it('appends -c when missing', () => {
    expect(syncContextFlagInManagedChatCommand('llama-server --port {{PORT}}', 4096, 'posix')).toContain(
      '-c 4096',
    );
  });
});

describe('suggestContextWindowTokens', () => {
  it('scales inferred context by fit preset', () => {
    const max = suggestContextWindowTokens('qwen2.5-7b', 'max');
    const balanced = suggestContextWindowTokens('qwen2.5-7b', 'balanced');
    const conservative = suggestContextWindowTokens('qwen2.5-7b', 'conservative');
    expect(max).toBeGreaterThanOrEqual(balanced);
    expect(balanced).toBeGreaterThanOrEqual(conservative);
  });
});

describe('formatReadyDefaultsSummary', () => {
  it('formats qwen summary', () => {
    expect(formatReadyDefaultsSummary({ preset: 'qwen', contextWindowTokens: 32_768 })).toContain('Qwen');
    expect(formatReadyDefaultsSummary({ preset: 'qwen', contextWindowTokens: 32_768 })).toContain('32k');
    expect(formatReadyDefaultsSummary({ preset: 'qwen', contextWindowTokens: 32_768 })).toContain('temp 0.65');
  });

  it('formats gemma summary with recommended sampling', () => {
    const s = formatReadyDefaultsSummary({ preset: 'gemma', contextWindowTokens: 16_384 });
    expect(s).toContain('Gemma');
    expect(s).toContain('temp 1');
    expect(s).toContain('top_p 0.95');
    expect(s).toContain('top_k 64');
  });
});

describe('optimizationPresetDefaultsPatch', () => {
  it('applies qwen defaults and clears gemma sampling leftovers', () => {
    expect(optimizationPresetDefaultsPatch('qwen')).toEqual({
      optimizationPreset: 'qwen',
      parallelToolCalls: false,
      maxOutputTokens: 0,
      temperature: 0.65,
      samplingPreset: 'provider-default',
      thinkingMode: 'default',
      topP: 0.95,
      topK: 20,
      repeatPenalty: 1,
    });
  });

  it('applies gemma recommended sampling onto the connection', () => {
    expect(optimizationPresetDefaultsPatch('gemma')).toEqual({
      optimizationPreset: 'gemma',
      parallelToolCalls: false,
      maxOutputTokens: 0,
      temperature: 1,
      samplingPreset: 'provider-default',
      thinkingMode: 'on',
      architectureHint: 'auto',
      topP: 0.95,
      topK: 64,
      repeatPenalty: undefined,
    });
  });

  it('clears sampling when returning to generic', () => {
    expect(optimizationPresetDefaultsPatch('generic')).toEqual({
      optimizationPreset: 'generic',
      samplingPreset: 'provider-default',
      thinkingMode: 'default',
      topP: undefined,
      topK: undefined,
      repeatPenalty: undefined,
    });
  });
});
