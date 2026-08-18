import {
  buildManagedLlamaChatCommand,
  formatReadyDefaultsSummary,
  hubCacheFolderToHfId,
  inferOptimizationPresetFromModelHint,
  managedLlamaCommandHasNoHost,
  optimizationPresetDefaultsPatch,
  parseCustomManagedContextTokens,
  parseManagedLlamaContextSize,
  parseManagedLlamaNgl,
  parseManagedLlamaModelSelection,
  managedPickerValueForCmd,
  promoteManagedSentinelNglToAuto,
  suggestContextWindowTokens,
  syncContextFlagInManagedChatCommand,
  syncNglFlagInManagedChatCommand,
  syncNoHostFlagInManagedChatCommand,
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

describe('parseCustomManagedContextTokens', () => {
  it('accepts positive integers and rejects invalid input', () => {
    expect(parseCustomManagedContextTokens('8192')).toBe(8192);
    expect(parseCustomManagedContextTokens(4096)).toBe(4096);
    expect(parseCustomManagedContextTokens(' 16384 ')).toBe(16384);
    expect(parseCustomManagedContextTokens('0')).toBeNull();
    expect(parseCustomManagedContextTokens('8192.5')).toBeNull();
    expect(parseCustomManagedContextTokens('abc')).toBeNull();
    expect(parseCustomManagedContextTokens('')).toBeNull();
    expect(parseCustomManagedContextTokens(-1)).toBeNull();
  });
});

describe('parseManagedLlamaContextSize', () => {
  it('parses -c and --ctx-size including 0', () => {
    expect(parseManagedLlamaContextSize('llama-server -c 8192 --port {{PORT}}')).toBe(8192);
    expect(parseManagedLlamaContextSize('llama-server --ctx-size 0 --port {{PORT}}')).toBe(0);
    expect(parseManagedLlamaContextSize('llama-server --ctx-size=4096 --port {{PORT}}')).toBe(4096);
    expect(parseManagedLlamaContextSize('llama-server --port {{PORT}}')).toBeNull();
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
    expect(cmd).toContain('--jinja');
    expect(cmd).not.toContain('--chat-template-file');
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

  it('emits -c 0 for model-native max context', () => {
    const cmd = buildManagedLlamaChatCommand(
      { kind: 'gguf', absolutePath: '/models/a.gguf' },
      0,
      'posix',
    );
    expect(cmd).toContain('-c 0');
    expect(cmd).not.toContain('-c 256');
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

describe('managedPickerValueForCmd', () => {
  it('maps a snapshot GGUF -m command back to the hub folder pick', () => {
    const snap = '/cache/models--org--name/snapshots/abc/model-Q4_K_M.gguf';
    const cmd = `llama-server --port {{PORT}} -m ${snap} -c 0`;
    expect(
      managedPickerValueForCmd(cmd, [
        {
          fileName: 'models--org--name',
          absolutePath: '/cache/models--org--name',
          sizeBytes: 1,
          modifiedMs: 0,
          source: 'custom',
          entryKind: 'hubRepo',
          ggufAbsolutePath: snap,
        },
      ]),
    ).toBe('hub:/cache/models--org--name');
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

  it('sets -c 0 without rewriting other flags', () => {
    const cmd =
      'llama-server --host 127.0.0.1 --port {{PORT}} -m /a.gguf -c 8192 --metrics -ngl 99';
    expect(syncContextFlagInManagedChatCommand(cmd, 0, 'posix')).toBe(
      'llama-server --host 127.0.0.1 --port {{PORT}} -m /a.gguf -c 0 --metrics -ngl 99',
    );
  });
});

describe('parseManagedLlamaNgl', () => {
  it('parses -ngl and long aliases, including 0', () => {
    expect(parseManagedLlamaNgl('llama-server -ngl 40 --port {{PORT}}')).toBe(40);
    expect(parseManagedLlamaNgl('llama-server --n-gpu-layers 0 --port {{PORT}}')).toBe(0);
    expect(parseManagedLlamaNgl('llama-server --gpu-layers=12 --port {{PORT}}')).toBe(12);
    expect(parseManagedLlamaNgl('llama-server --port {{PORT}}')).toBeNull();
  });

  it('parses auto, all, and llama.cpp sentinels as 99', () => {
    expect(parseManagedLlamaNgl('llama-server -ngl auto --port {{PORT}}')).toBe(99);
    expect(parseManagedLlamaNgl('llama-server -ngl all --port {{PORT}}')).toBe(99);
    expect(parseManagedLlamaNgl('llama-server -ngl -1 --port {{PORT}}')).toBe(99);
    expect(parseManagedLlamaNgl('llama-server -ngl -2 --port {{PORT}}')).toBe(99);
    expect(parseManagedLlamaNgl('llama-server -ngl 999 --port {{PORT}}')).toBe(99);
  });
});

describe('syncNglFlagInManagedChatCommand', () => {
  it('updates existing -ngl', () => {
    expect(syncNglFlagInManagedChatCommand('llama-server -ngl 99 --port {{PORT}}', 40, 'posix')).toBe(
      'llama-server -ngl 40 --port {{PORT}}',
    );
  });

  it('keeps --n-gpu-layers form when replacing', () => {
    expect(
      syncNglFlagInManagedChatCommand('llama-server --n-gpu-layers 8 --port {{PORT}}', 16, 'posix'),
    ).toBe('llama-server --n-gpu-layers 16 --port {{PORT}}');
  });

  it('appends -ngl when missing', () => {
    expect(syncNglFlagInManagedChatCommand('llama-server --port {{PORT}}', 0, 'posix')).toContain('-ngl 0');
  });

  it('writes -ngl auto at 99 so llama.cpp --fit can use VRAM', () => {
    const cmd = 'llama-server --host 127.0.0.1 --port {{PORT}} -m /a.gguf -c 8192 --metrics';
    expect(syncNglFlagInManagedChatCommand(cmd, 99, 'posix')).toBe(
      'llama-server --host 127.0.0.1 --port {{PORT}} -m /a.gguf -c 8192 --metrics -ngl auto',
    );
  });

  it('replaces a pinned 99 with auto', () => {
    expect(syncNglFlagInManagedChatCommand('llama-server -ngl 99 --port {{PORT}}', 99, 'posix')).toBe(
      'llama-server -ngl auto --port {{PORT}}',
    );
  });
});

describe('promoteManagedSentinelNglToAuto', () => {
  it('rewrites Clara sentinel -ngl 99 to auto', () => {
    expect(
      promoteManagedSentinelNglToAuto(
        'llama-server --host 127.0.0.1 --port {{PORT}} -hf unsloth/gemma-4-12b-it-GGUF -c 0 --metrics -ngl 99 --no-host -dev CUDA0 --main-gpu 0',
        'posix',
      ),
    ).toContain('-ngl auto');
  });

  it('leaves exact layer counts and -ngl all alone', () => {
    expect(promoteManagedSentinelNglToAuto('llama-server -ngl 40 --port {{PORT}}', 'posix')).toBe(
      'llama-server -ngl 40 --port {{PORT}}',
    );
    expect(promoteManagedSentinelNglToAuto('llama-server -ngl all --port {{PORT}}', 'posix')).toBe(
      'llama-server -ngl all --port {{PORT}}',
    );
    expect(promoteManagedSentinelNglToAuto('llama-server -ngl 999 --port {{PORT}}', 'posix')).toBe(
      'llama-server -ngl 999 --port {{PORT}}',
    );
  });

  it('no-ops when -ngl is absent', () => {
    const cmd = 'llama-server --port {{PORT}} -c 0';
    expect(promoteManagedSentinelNglToAuto(cmd, 'posix')).toBe(cmd);
  });
});

describe('syncNoHostFlagInManagedChatCommand', () => {
  it('appends --no-host when missing', () => {
    expect(syncNoHostFlagInManagedChatCommand('llama-server --host 127.0.0.1 --port {{PORT}}', true)).toBe(
      'llama-server --host 127.0.0.1 --port {{PORT}} --no-host',
    );
  });

  it('does not duplicate --no-host', () => {
    const cmd = 'llama-server --no-host --port {{PORT}}';
    expect(syncNoHostFlagInManagedChatCommand(cmd, true)).toBe(cmd);
  });

  it('removes --no-host without touching --host', () => {
    expect(
      syncNoHostFlagInManagedChatCommand(
        'llama-server --host 127.0.0.1 --port {{PORT}} --no-host -ngl 99',
        false,
      ),
    ).toBe('llama-server --host 127.0.0.1 --port {{PORT}} -ngl 99');
  });

  it('detects --no-host without matching --host', () => {
    expect(managedLlamaCommandHasNoHost('llama-server --host 127.0.0.1 --port {{PORT}}')).toBe(false);
    expect(managedLlamaCommandHasNoHost('llama-server --host 127.0.0.1 --port {{PORT}} --no-host')).toBe(
      true,
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
  });

  it('labels model-native context as max instead of a guessed window', () => {
    expect(formatReadyDefaultsSummary({ preset: 'qwen', contextWindowTokens: 32_768, contextMax: true })).toBe(
      'Qwen · ctx max · temp 0.65',
    );
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
