import {
  buildManagedLlamaChatCommand,
  formatReadyDefaultsSummary,
  hubCacheFolderToHfId,
  inferOptimizationPresetFromModelHint,
  parseManagedLlamaCheckpointSettings,
  parseManagedLlamaModelSelection,
  suggestContextWindowTokens,
  syncCheckpointFlagsInManagedChatCommand,
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
    expect(cmd).toContain('--ctx-checkpoints 0');
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

describe('syncCheckpointFlagsInManagedChatCommand', () => {
  it('disables checkpoints with recommended flags', () => {
    const cmd = syncCheckpointFlagsInManagedChatCommand(
      'llama-server --port {{PORT}} -m /x.gguf -c 8192',
      { mode: 'disabled', ctxCheckpoints: 0, checkpointEveryNTokens: -1 },
      'posix',
    );
    expect(cmd).toContain('--ctx-checkpoints 0');
    expect(cmd).toContain('--checkpoint-every-n-tokens -1');
  });

  it('removes flags for server-default', () => {
    const cmd = syncCheckpointFlagsInManagedChatCommand(
      'llama-server --port {{PORT}} --ctx-checkpoints 0 --checkpoint-every-n-tokens -1',
      { mode: 'server-default', ctxCheckpoints: 0, checkpointEveryNTokens: -1 },
      'posix',
    );
    expect(cmd).not.toContain('--ctx-checkpoints');
    expect(cmd).not.toContain('--checkpoint-every-n-tokens');
  });

  it('writes custom values', () => {
    const cmd = syncCheckpointFlagsInManagedChatCommand(
      'llama-server --port {{PORT}}',
      { mode: 'custom', ctxCheckpoints: 2, checkpointEveryNTokens: 4096 },
      'posix',
    );
    expect(cmd).toContain('--ctx-checkpoints 2');
    expect(cmd).toContain('--checkpoint-every-n-tokens 4096');
  });
});

describe('parseManagedLlamaCheckpointSettings', () => {
  it('detects disabled, custom, and server-default', () => {
    expect(
      parseManagedLlamaCheckpointSettings(
        'llama-server --ctx-checkpoints 0 --checkpoint-every-n-tokens -1',
      ).mode,
    ).toBe('disabled');
    expect(
      parseManagedLlamaCheckpointSettings(
        'llama-server --ctx-checkpoints 3 --checkpoint-every-n-tokens 1024',
      ),
    ).toEqual({ mode: 'custom', ctxCheckpoints: 3, checkpointEveryNTokens: 1024 });
    expect(parseManagedLlamaCheckpointSettings('llama-server --port {{PORT}}').mode).toBe(
      'server-default',
    );
  });
});

describe('formatReadyDefaultsSummary', () => {
  it('formats qwen summary', () => {
    expect(formatReadyDefaultsSummary({ preset: 'qwen', contextWindowTokens: 32_768 })).toContain('Qwen');
    expect(formatReadyDefaultsSummary({ preset: 'qwen', contextWindowTokens: 32_768 })).toContain('32k');
  });
});
