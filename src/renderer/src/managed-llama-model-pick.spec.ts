import {
  buildManagedLlamaChatCommand,
  classifyHubSnapshotGgufPaths,
  ensureManagedLlamaDefaultServerFlags,
  ensureManagedLlamaFitContextFloor,
  ensureManagedLlamaGemmaReasoningFormat,
  formatReadyDefaultsSummary,
  hubCacheFolderToHfId,
  hubSnapshotManagedPaths,
  inferOptimizationPresetFromModelHint,
  isDraftSidecarGgufFileName,
  isMmprojGgufFileName,
  isMtpCompanionGgufFileName,
  languageGgufStem,
  limitManagedLlamaCacheRam,
  managedLlamaCommandHasNoHost,
  managedLlamaCommandHasNoMmproj,
  managedMtpHead,
  optimizationPresetDefaultsPatch,
  outerAgentBriefEnabled,
  parseCustomManagedContextTokens,
  parseManagedLlamaBatchSize,
  parseManagedLlamaCacheTypeK,
  parseManagedLlamaCacheTypeV,
  parseManagedLlamaContextSize,
  parseManagedLlamaFlashAttn,
  parseManagedLlamaMmproj,
  parseManagedLlamaNgl,
  parseManagedLlamaModelSelection,
  parseManagedLlamaUbatchSize,
  pickPreferredMmprojPath,
  resolveMmprojPathForManagedGguf,
  resolveMmprojPathForManagedSelection,
  resolveMtpPathForManagedGguf,
  managedPickerValueForCmd,
  promoteManagedSentinelNglToAuto,
  suggestContextWindowTokens,
  syncBatchSizeInManagedChatCommand,
  syncCacheTypeKInManagedChatCommand,
  syncCacheTypeVInManagedChatCommand,
  syncContextFlagInManagedChatCommand,
  syncFlashAttnInManagedChatCommand,
  syncManagedVisionProjectorInChatCommand,
  syncMmprojFlagInManagedChatCommand,
  syncMtpDraftInManagedChatCommand,
  syncNglFlagInManagedChatCommand,
  syncNoHostFlagInManagedChatCommand,
  syncNoMmprojFlagInManagedChatCommand,
  syncUbatchSizeInManagedChatCommand,
  tunePickedManagedChatCommand,
  withoutAutoTunedFlags,
  type CudaGpuDevice,
  type GgufProfile,
  type ModelManagerFileEntry,
  type PickedManagedModelFacts,
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

describe('hub snapshot mmproj detection', () => {
  it('recognizes mmproj GGUF names used by llama.cpp and Nemotron VL', () => {
    expect(isMmprojGgufFileName('mmproj-F16.gguf')).toBe(true);
    expect(isMmprojGgufFileName('NVIDIA-Nemotron-Nano-12B-v2-VL-mmproj-F16.gguf')).toBe(true);
    expect(isMmprojGgufFileName('/cache/snapshots/abc/mmproj-Q8_0.gguf')).toBe(true);
    expect(isMmprojGgufFileName('model-Q4_K_M.gguf')).toBe(false);
  });

  it('pins -m when a hub folder has one language GGUF plus an mmproj', () => {
    const language = '/cache/models--org--vl/snapshots/abc/nano-Q4_K_M.gguf';
    const mmproj = '/cache/models--org--vl/snapshots/abc/mmproj-F16.gguf';
    expect(hubSnapshotManagedPaths([language, mmproj])).toEqual({
      ggufAbsolutePath: language,
      mmprojAbsolutePath: mmproj,
    });
    expect(classifyHubSnapshotGgufPaths([language, mmproj]).languagePaths).toEqual([language]);
  });

  it('does not treat a lone mmproj as the language model', () => {
    const mmproj = '/cache/hub/snapshots/abc/mmproj-F16.gguf';
    expect(hubSnapshotManagedPaths([mmproj])).toEqual({ mmprojAbsolutePath: mmproj });
  });

  it('keeps mmproj when several language quants exist, without pinning -m', () => {
    const q4 = '/cache/hub/snapshots/abc/model-Q4_K_M.gguf';
    const q5 = '/cache/hub/snapshots/abc/model-Q5_K_M.gguf';
    const mmproj = '/cache/hub/snapshots/abc/mmproj-F16.gguf';
    expect(hubSnapshotManagedPaths([q4, q5, mmproj])).toEqual({ mmprojAbsolutePath: mmproj });
  });

  it('prefers F16 over Q8_0 when several projectors are present', () => {
    expect(
      pickPreferredMmprojPath([
        '/hub/mmproj-Q8_0.gguf',
        '/hub/mmproj-F16.gguf',
      ]),
    ).toBe('/hub/mmproj-F16.gguf');
  });

  it('resolves a hub mmproj for a -m snapshot path', () => {
    const snap = '/cache/models--org--vl/snapshots/abc/nano-Q4_K_M.gguf';
    const mmproj = '/cache/models--org--vl/snapshots/abc/mmproj-F16.gguf';
    expect(
      resolveMmprojPathForManagedGguf(snap, [
        {
          fileName: 'models--org--vl',
          absolutePath: '/cache/models--org--vl',
          sizeBytes: 1,
          modifiedMs: 0,
          source: 'custom',
          entryKind: 'hubRepo',
          ggufAbsolutePath: snap,
          mmprojAbsolutePath: mmproj,
        },
      ]),
    ).toBe(mmproj);
  });

  it('resolves a hub mmproj for an -hf command matching the cache folder', () => {
    const mmproj = '/cache/models--org--vl/snapshots/abc/mmproj-F16.gguf';
    expect(
      resolveMmprojPathForManagedSelection(
        { kind: 'hf', hfId: 'org/vl:Q4_K_M' },
        [
          {
            fileName: 'models--org--vl',
            absolutePath: '/cache/models--org--vl',
            sizeBytes: 1,
            modifiedMs: 0,
            source: 'custom',
            entryKind: 'hubRepo',
            mmprojAbsolutePath: mmproj,
          },
        ],
      ),
    ).toBe(mmproj);
  });

  it('resolves a sibling loose mmproj next to a -m GGUF', () => {
    expect(
      resolveMmprojPathForManagedGguf('/models/nano-Q4_K_M.gguf', [
        {
          fileName: 'nano-Q4_K_M.gguf',
          absolutePath: '/models/nano-Q4_K_M.gguf',
          sizeBytes: 1,
          modifiedMs: 0,
          source: 'custom',
        },
        {
          fileName: 'mmproj-F16.gguf',
          absolutePath: '/models/mmproj-F16.gguf',
          sizeBytes: 1,
          modifiedMs: 0,
          source: 'custom',
        },
      ]),
    ).toBe('/models/mmproj-F16.gguf');
  });

  it('does not attach a generic mmproj from a shared dump to Nemotron Lightning', () => {
    const dump = [
      {
        fileName: 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q8_K_XL.gguf',
        absolutePath: '/models/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q8_K_XL.gguf',
        sizeBytes: 1,
        modifiedMs: 0,
        source: 'custom' as const,
      },
      {
        fileName: 'gemma_4_12b_CLARA.gguf',
        absolutePath: '/models/gemma_4_12b_CLARA.gguf',
        sizeBytes: 1,
        modifiedMs: 0,
        source: 'custom' as const,
      },
      {
        fileName: 'mmproj-BF16.gguf',
        absolutePath: '/models/mmproj-BF16.gguf',
        sizeBytes: 1,
        modifiedMs: 0,
        source: 'custom' as const,
      },
      {
        fileName: 'mmproj-Qwen3.6-27B-f16.gguf',
        absolutePath: '/models/mmproj-Qwen3.6-27B-f16.gguf',
        sizeBytes: 1,
        modifiedMs: 0,
        source: 'custom' as const,
      },
    ];
    expect(
      resolveMmprojPathForManagedGguf(
        '/models/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q8_K_XL.gguf',
        dump,
      ),
    ).toBeNull();
  });

  it('pairs a filename-matched mmproj in a shared dump', () => {
    expect(
      resolveMmprojPathForManagedGguf('/models/Qwen3.6-27B-Q4_K_M.gguf', [
        {
          fileName: 'Qwen3.6-27B-Q4_K_M.gguf',
          absolutePath: '/models/Qwen3.6-27B-Q4_K_M.gguf',
          sizeBytes: 1,
          modifiedMs: 0,
          source: 'custom',
        },
        {
          fileName: 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q8_K_XL.gguf',
          absolutePath: '/models/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q8_K_XL.gguf',
          sizeBytes: 1,
          modifiedMs: 0,
          source: 'custom',
        },
        {
          fileName: 'mmproj-Qwen3.6-27B-f16.gguf',
          absolutePath: '/models/mmproj-Qwen3.6-27B-f16.gguf',
          sizeBytes: 1,
          modifiedMs: 0,
          source: 'custom',
        },
      ]),
    ).toBe('/models/mmproj-Qwen3.6-27B-f16.gguf');
  });
});

describe('MTP head files', () => {
  const swift = '/models/models--ajgazin--Swift/snapshots/abc/Swift-1.5-Qwen3.8-27B-Uncensored-Dynamic-MTP-UD-Q6_K_XL.gguf';
  const gemma = '/models/gemma/gemma-4-12B-it-Q4_0.gguf';
  const head = '/models/gemma/mtp-gemma-4-12B-it-Q4_0.gguf';
  const loose = (absolutePath: string): ModelManagerFileEntry => ({
    fileName: absolutePath.split('/').pop() as string,
    absolutePath,
    sizeBytes: 1,
    modifiedMs: 0,
    source: 'custom',
  });

  it('are named with an mtp- prefix, which a model with a head inside it is not', () => {
    expect(isMtpCompanionGgufFileName('mtp-gemma-4-12B-it-Q4_0.gguf')).toBe(true);
    expect(isMtpCompanionGgufFileName('MTP-gemma.gguf')).toBe(true);
    expect(isMtpCompanionGgufFileName(head)).toBe(true);
    expect(isMtpCompanionGgufFileName('C:\\models\\mtp-gemma.gguf')).toBe(true);
    expect(isMtpCompanionGgufFileName(swift)).toBe(false);
    expect(isMtpCompanionGgufFileName('/models/mtp-dir/model.gguf')).toBe(false);
  });

  it('do not count as the language model of a hub folder, so it still pins -m', () => {
    expect(hubSnapshotManagedPaths([gemma, head])).toEqual({ ggufAbsolutePath: gemma, mtpAbsolutePath: head });
    expect(classifyHubSnapshotGgufPaths([gemma, head]).languagePaths).toEqual([gemma]);
    expect(hubSnapshotManagedPaths([swift])).toEqual({ ggufAbsolutePath: swift });
    expect(hubSnapshotManagedPaths([head])).toEqual({ mtpAbsolutePath: head });
  });

  it('share a stem with their model, whatever its quant', () => {
    expect(languageGgufStem(head)).toBe('gemma-4-12b-it');
    expect(languageGgufStem(head)).toBe(languageGgufStem(gemma));
    expect(languageGgufStem('/models/gemma/gemma-4-12B-it-Q8_0.gguf')).toBe(languageGgufStem(head));
  });

  it('do not stop a generic projector pairing with the one model beside them', () => {
    const mmproj = '/models/gemma/mmproj-F16.gguf';
    expect(resolveMmprojPathForManagedGguf(gemma, [loose(gemma), loose(head), loose(mmproj)])).toBe(mmproj);
    expect(resolveMmprojPathForManagedGguf(gemma, [loose(gemma), loose('/models/gemma/other.gguf'), loose(mmproj)])).toBeNull();
  });

  it('are found beside the model by stem, or in its hub folder', () => {
    expect(resolveMtpPathForManagedGguf(gemma, [loose(gemma), loose(head)])).toBe(head);
    expect(resolveMtpPathForManagedGguf('/models/gemma/gemma-4-12B-it-Q8_0.gguf', [loose(head)])).toBe(head);
    expect(resolveMtpPathForManagedGguf('/models/gemma/other-Q4_0.gguf', [loose(head)])).toBeNull();
    expect(resolveMtpPathForManagedGguf('/elsewhere/gemma-4-12B-it-Q4_0.gguf', [loose(head)])).toBeNull();
    expect(resolveMtpPathForManagedGguf('', [loose(head)])).toBeNull();
    const hub: ModelManagerFileEntry = {
      ...loose('/hub/models--org--repo'),
      entryKind: 'hubRepo',
      mtpAbsolutePath: '/hub/models--org--repo/snapshots/a/mtp-repo-Q4_0.gguf',
    };
    expect(resolveMtpPathForManagedGguf('/hub/models--org--repo/snapshots/a/repo-Q4_0.gguf', [hub])).toBe(hub.mtpAbsolutePath);
    expect(resolveMtpPathForManagedGguf('/hub/models--org--repo2/snapshots/a/repo-Q4_0.gguf', [hub])).toBeNull();
  });
});

describe('draft head files', () => {
  const model = '/models/qwen/Qwen3.6-27B-Q4_K_M.gguf';
  const head = '/models/qwen/dflash-Qwen3.6-27B-Q8_0.gguf';
  const loose = (absolutePath: string): ModelManagerFileEntry => ({
    fileName: absolutePath.split('/').pop() as string,
    absolutePath,
    sizeBytes: 1,
    modifiedMs: 0,
    source: 'custom',
  });

  it.each([
    'eagle3-gpt-oss-20b-BF16.gguf',
    'dflash-Qwen3.6-27B-Q8_0.gguf',
    'dspark-model-Q8_0.gguf',
    'laguna-s-2.1-DFlash-BF16.gguf',
    'Qwen3-4B-DFlash.gguf',
    'C:\\models\\EAGLE3-a.ggml',
    '/models/qwen/model_dflash_Q8_0.gguf',
  ])('are told by the kind in the name: %s', (name) => {
    expect(isDraftSidecarGgufFileName(name)).toBe(true);
    expect(isMtpCompanionGgufFileName(name)).toBe(false);
  });

  it.each([
    'gpt-oss-20b-MXFP4.gguf',
    'Qwen3.6-27B-Q4_K_M.gguf',
    'Swift-1.5-Qwen3.8-27B-Uncensored-Dynamic-MTP-UD-Q6_K_XL.gguf',
    'mtp-gemma-4-12B-it-Q4_0.gguf',
    'dflashy-Q4_0.gguf',
    'eagle-Q4_0.gguf',
    '/models/dflash/model-Q4_0.gguf',
    '/models/models--z-lab--Qwen3-4B-DFlash/snapshots/a/other-Q4_0.gguf',
  ])('are not confused with %s', (name) => {
    expect(isDraftSidecarGgufFileName(name)).toBe(false);
  });

  it('do not count as the language model of a hub folder, so it still pins -m', () => {
    expect(hubSnapshotManagedPaths([model, head])).toEqual({ ggufAbsolutePath: model });
    expect(classifyHubSnapshotGgufPaths([model, head]).languagePaths).toEqual([model]);
  });

  it('are never pinned as the model, or taken for an MTP head', () => {
    expect(hubSnapshotManagedPaths([head])).toEqual({});
    expect(classifyHubSnapshotGgufPaths([head]).mtpPath).toBeNull();
    expect(resolveMtpPathForManagedGguf(model, [loose(model), loose(head)])).toBeNull();
  });

  it('do not stop a generic projector pairing with the one model beside them', () => {
    const mmproj = '/models/qwen/mmproj-BF16.gguf';
    expect(resolveMmprojPathForManagedGguf(model, [loose(model), loose(head), loose(mmproj)])).toBe(mmproj);
    expect(
      resolveMmprojPathForManagedGguf(model, [loose(model), loose('/models/qwen/other.gguf'), loose(mmproj)]),
    ).toBeNull();
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
    expect(cmd).not.toContain('-np');
    expect(cmd).not.toContain('--no-webui');
    expect(cmd).not.toContain('--cache-ram');
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

  it('leaves -c out for model-native max context, so --fit can still shrink it', () => {
    const cmd = buildManagedLlamaChatCommand(
      { kind: 'gguf', absolutePath: '/models/a.gguf' },
      0,
      'posix',
    );
    expect(parseManagedLlamaContextSize(cmd)).toBeNull();
    expect(cmd).toContain('--metrics');
  });

  it('attaches --mmproj on a local -m command when a projector path is known', () => {
    const cmd = buildManagedLlamaChatCommand(
      {
        kind: 'gguf',
        absolutePath: '/cache/hub/snapshots/abc/nano-Q4_K_M.gguf',
        mmprojAbsolutePath: '/cache/hub/snapshots/abc/mmproj-F16.gguf',
      },
      0,
      'posix',
    );
    expect(cmd).toContain('-m /cache/hub/snapshots/abc/nano-Q4_K_M.gguf');
    expect(cmd).toContain('--mmproj /cache/hub/snapshots/abc/mmproj-F16.gguf');
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

describe('flash attn / mmproj / batch / cache flags', () => {
  it('parses -fa on, off, auto, and bare -fa as on', () => {
    expect(parseManagedLlamaFlashAttn('llama-server -fa on --port {{PORT}}')).toBe('on');
    expect(parseManagedLlamaFlashAttn('llama-server --flash-attn off --port {{PORT}}')).toBe('off');
    expect(parseManagedLlamaFlashAttn('llama-server --flash-attn=auto --port {{PORT}}')).toBe('auto');
    expect(parseManagedLlamaFlashAttn('llama-server -fa --port {{PORT}}')).toBe('on');
    expect(parseManagedLlamaFlashAttn('llama-server --port {{PORT}}')).toBeNull();
  });

  it('writes -fa and keeps the long form when present', () => {
    expect(syncFlashAttnInManagedChatCommand('llama-server -fa on --port {{PORT}}', 'auto', 'posix')).toBe(
      'llama-server -fa auto --port {{PORT}}',
    );
    expect(
      syncFlashAttnInManagedChatCommand('llama-server --flash-attn off --port {{PORT}}', 'on', 'posix'),
    ).toBe('llama-server --flash-attn on --port {{PORT}}');
    expect(syncFlashAttnInManagedChatCommand('llama-server --port {{PORT}}', 'on', 'posix')).toContain(
      '-fa on',
    );
  });

  it('appends and strips --no-mmproj without matching --no-mmproj-auto', () => {
    expect(managedLlamaCommandHasNoMmproj('llama-server --no-mmproj-auto --port {{PORT}}')).toBe(false);
    expect(syncNoMmprojFlagInManagedChatCommand('llama-server --port {{PORT}}', true)).toBe(
      'llama-server --port {{PORT}} --no-mmproj',
    );
    expect(
      syncNoMmprojFlagInManagedChatCommand('llama-server --port {{PORT}} --no-mmproj -ngl auto', false),
    ).toBe('llama-server --port {{PORT}} -ngl auto');
  });

  it('parses and syncs --mmproj without matching --mmproj-auto or --no-mmproj', () => {
    expect(parseManagedLlamaMmproj('llama-server --mmproj-auto --port {{PORT}}')).toBeNull();
    expect(parseManagedLlamaMmproj('llama-server --no-mmproj --port {{PORT}}')).toBeNull();
    expect(parseManagedLlamaMmproj('llama-server --mmproj /hub/mmproj-F16.gguf -m /hub/a.gguf')).toBe(
      '/hub/mmproj-F16.gguf',
    );
    expect(syncMmprojFlagInManagedChatCommand('llama-server --port {{PORT}} -m /a.gguf', '/hub/mmproj.gguf', 'posix')).toBe(
      'llama-server --port {{PORT}} -m /a.gguf --mmproj /hub/mmproj.gguf',
    );
    expect(
      syncMmprojFlagInManagedChatCommand(
        'llama-server --mmproj /old.gguf --port {{PORT}}',
        '/new.gguf',
        'posix',
      ),
    ).toBe('llama-server --port {{PORT}} --mmproj /new.gguf');
    expect(syncMmprojFlagInManagedChatCommand('llama-server --mmproj /hub/p.gguf -m /a.gguf', null, 'posix')).toBe(
      'llama-server -m /a.gguf',
    );
    expect(
      syncMmprojFlagInManagedChatCommand(
        'llama-server --mmproj /old.gguf --port {{PORT}} --mmproj /also.gguf -m /a.gguf',
        '/hub/mmproj.gguf',
        'posix',
      ),
    ).toBe('llama-server --port {{PORT}} -m /a.gguf --mmproj /hub/mmproj.gguf');
  });

  it('Auto pins --mmproj on -m and Off strips it for --no-mmproj', () => {
    const cmd = 'llama-server --port {{PORT}} -m /hub/a.gguf -c 0';
    expect(
      syncManagedVisionProjectorInChatCommand(
        cmd,
        { noMmproj: false, mmprojPath: '/hub/mmproj-F16.gguf' },
        'posix',
      ),
    ).toBe('llama-server --port {{PORT}} -m /hub/a.gguf -c 0 --mmproj /hub/mmproj-F16.gguf');
    expect(
      syncManagedVisionProjectorInChatCommand(
        `${cmd} --mmproj /hub/mmproj-F16.gguf`,
        { noMmproj: true, mmprojPath: '/hub/mmproj-F16.gguf' },
        'posix',
      ),
    ).toBe('llama-server --port {{PORT}} -m /hub/a.gguf -c 0 --no-mmproj');
  });

  it('treats batch 0 as omit and writes positive -b / -ub', () => {
    const cmd = 'llama-server --port {{PORT}} -m /a.gguf -c 0 --metrics';
    expect(parseManagedLlamaBatchSize(cmd)).toBeNull();
    expect(syncBatchSizeInManagedChatCommand(cmd, 2048, 'posix')).toContain('-b 2048');
    expect(syncBatchSizeInManagedChatCommand(`${cmd} -b 2048`, 0, 'posix')).toBe(cmd);
    expect(syncUbatchSizeInManagedChatCommand(cmd, 1024, 'posix')).toContain('-ub 1024');
    expect(parseManagedLlamaUbatchSize('llama-server --ubatch-size 512 --port {{PORT}}')).toBe(512);
  });

  it('writes and strips -ctk / -ctv dropdown values', () => {
    const cmd = 'llama-server --port {{PORT}} -m /a.gguf';
    expect(parseManagedLlamaCacheTypeK(cmd)).toBeNull();
    expect(syncCacheTypeKInManagedChatCommand(cmd, 'q8_0', 'posix')).toContain('-ctk q8_0');
    expect(syncCacheTypeVInManagedChatCommand(`${cmd} -ctv f16`, 'q4_0', 'posix')).toContain('-ctv q4_0');
    expect(syncCacheTypeKInManagedChatCommand(`${cmd} -ctk q8_0`, null, 'posix')).toBe(cmd);
    expect(parseManagedLlamaCacheTypeK('llama-server --cache-type-k bf16 --port {{PORT}}')).toBe('bf16');
  });
});

describe('ensureManagedLlamaDefaultServerFlags', () => {
  it('appends --no-webui and -np 1 when missing, and no --cache-ram', () => {
    expect(ensureManagedLlamaDefaultServerFlags('llama-server --port {{PORT}} -m /a.gguf')).toBe(
      'llama-server --port {{PORT}} -m /a.gguf --no-webui -np 1',
    );
  });

  it('does not duplicate flags or overwrite an existing -np / --cache-ram', () => {
    const cmd = 'llama-server --no-webui -np 4 --cache-ram 2048 --port {{PORT}}';
    expect(ensureManagedLlamaDefaultServerFlags(cmd)).toBe(cmd);
  });

  it('treats --no-ui as already disabling the web UI', () => {
    expect(ensureManagedLlamaDefaultServerFlags('llama-server --no-ui --port {{PORT}}')).toBe(
      'llama-server --no-ui --port {{PORT}} -np 1',
    );
  });
});

describe('limitManagedLlamaCacheRam', () => {
  const GIB = 1024 * 1024 * 1024;
  const cmd = 'llama-server --port {{PORT}} -m /a.gguf';

  it('caps the prompt cache under 24 GiB of RAM', () => {
    expect(limitManagedLlamaCacheRam(cmd, 16 * GIB)).toBe(`${cmd} --cache-ram 2048`);
    expect(limitManagedLlamaCacheRam(cmd, 24 * GIB - 1)).toBe(`${cmd} --cache-ram 2048`);
  });

  it('keeps the server default from 24 GiB up', () => {
    expect(limitManagedLlamaCacheRam(cmd, 24 * GIB)).toBe(cmd);
    expect(limitManagedLlamaCacheRam(cmd, 32 * GIB)).toBe(cmd);
  });

  it('never overrides what the command sets, in either spelling', () => {
    for (const flag of ['--cache-ram 0', '--cache-ram -1', '--cache-ram 8192', '-cram 512']) {
      expect(limitManagedLlamaCacheRam(`${cmd} ${flag}`, 8 * GIB)).toBe(`${cmd} ${flag}`);
    }
  });

  it('leaves an empty command empty', () => {
    expect(limitManagedLlamaCacheRam('', 8 * GIB)).toBe('');
  });
});

describe('ensureManagedLlamaFitContextFloor', () => {
  const bare = 'llama-server -m /m/a.gguf';

  it('holds --fit above the prompt when the command sets no context', () => {
    expect(ensureManagedLlamaFitContextFloor(bare)).toBe(`${bare} --fit-ctx 16384`);
  });

  it('leaves a command with a -c, which already stops the shrink, or its own floor', () => {
    for (const flag of ['-c 0', '-c 8192', '--ctx-size 8192', '-fitc 4096', '--fit-ctx 4096']) {
      expect(ensureManagedLlamaFitContextFloor(`${bare} ${flag}`)).toBe(`${bare} ${flag}`);
    }
  });

  it('leaves an empty command empty', () => {
    expect(ensureManagedLlamaFitContextFloor('  ')).toBe('  ');
  });
});

describe('withoutAutoTunedFlags', () => {
  const autoTuned = { c: 65536, ctk: 'q8_0', ctv: 'q8_0' };

  it('takes out what the plan wrote, and nothing else', () => {
    expect(withoutAutoTunedFlags('llama-server -m /a.gguf -c 65536 -ctk q8_0 -ctv q8_0 --no-mmap', autoTuned, 'posix')).toBe(
      'llama-server -m /a.gguf --no-mmap',
    );
  });

  it('leaves what the user wrote', () => {
    const command = 'llama-server -m /a.gguf -c 50000 -ctk f16 -ctv f16';
    expect(withoutAutoTunedFlags(command, autoTuned, 'posix')).toBe(command);
    expect(withoutAutoTunedFlags(command, { c: 65536, ctk: '', ctv: '' }, 'posix')).toBe(command);
  });

  it('leaves a command with no plan on file', () => {
    const command = 'llama-server -m /a.gguf -c 65536 -ctk q8_0 -ctv q8_0';
    expect(withoutAutoTunedFlags(command, undefined, 'posix')).toBe(command);
    expect(withoutAutoTunedFlags('llama-server -m /a.gguf', undefined, 'posix')).toBe('llama-server -m /a.gguf');
  });
});

describe('managed MTP decoding', () => {
  /** Only the fields these helpers read. */
  const profile = (over: Partial<GgufProfile>): GgufProfile => ({
    contextTrain: 262144,
    embeddingOut: 3840,
    nextnLayers: 0,
    tensorBytes: 7 * 1024 ** 3,
    hostBytes: 0,
    headBytes: 0,
    recurrentStateBytes: 0,
    fullKeys: 4096,
    fullValues: 4096,
    maxFullKey: 512,
    swaKeys: 0,
    swaValues: 0,
    slidingWindow: 0,
    cacheLengths: [512, 256],
    ...over,
  });
  const companion = profile({ nextnLayers: 4, tensorBytes: 227 * 1024 ** 2 });
  const path = '/m/mtp-a.gguf';

  describe('managedMtpHead', () => {
    it('prefers a head inside the model', () => {
      expect(managedMtpHead(profile({ nextnLayers: 1 }), path, companion)).toEqual({ companionPath: null });
      expect(managedMtpHead(profile({ nextnLayers: 1 }), null, null)).toEqual({ companionPath: null });
    });

    it('takes a companion only with a header that pairs with the model', () => {
      expect(managedMtpHead(profile({}), path, companion)).toEqual({ companionPath: path });
      expect(managedMtpHead(profile({}), path, { ...companion, embeddingOut: 2560 })).toBeNull();
      expect(managedMtpHead(profile({}), path, { ...companion, nextnLayers: 0 })).toBeNull();
      expect(managedMtpHead(profile({}), path, null)).toBeNull();
      expect(managedMtpHead(profile({}), null, null)).toBeNull();
    });
  });

  describe('syncMtpDraftInManagedChatCommand', () => {
    it('writes the flags for a companion head', () => {
      expect(syncMtpDraftInManagedChatCommand('llama-server -m /m/a.gguf', { companionPath: path }, 'posix')).toBe(
        `llama-server -m /m/a.gguf --spec-type draft-mtp --spec-draft-model ${path} --spec-draft-n-max 4`,
      );
    });

    it('names no file for a head inside the model, and takes away a stale one', () => {
      expect(syncMtpDraftInManagedChatCommand('llama-server -md /old.gguf', { companionPath: null }, 'posix')).toBe(
        'llama-server --spec-type draft-mtp --spec-draft-n-max 4',
      );
    });

    it('keeps the user n-max and other speculative types', () => {
      expect(
        syncMtpDraftInManagedChatCommand('llama-server --spec-draft-n-max 2 --spec-type ngram-mod', { companionPath: null }, 'posix'),
      ).toBe('llama-server --spec-draft-n-max 2 --spec-type ngram-mod,draft-mtp');
    });

    it('changes nothing when it is already on', () => {
      const on = 'llama-server --spec-type draft-mtp --spec-draft-n-max 4';
      expect(syncMtpDraftInManagedChatCommand(on, { companionPath: null }, 'posix')).toBe(on);
    });

    it('quotes a companion path that needs it', () => {
      expect(syncMtpDraftInManagedChatCommand('llama-server', { companionPath: '/a b/mtp.gguf' }, 'posix')).toContain(
        "--spec-draft-model '/a b/mtp.gguf'",
      );
    });
  });

  describe('tunePickedManagedChatCommand', () => {
    const gpu: CudaGpuDevice = { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 15995 };
    const facts = (over: Partial<PickedManagedModelFacts>): PickedManagedModelFacts => ({
      command: 'llama-server -m /m/a.gguf --metrics',
      previous: '',
      autoTuned: undefined,
      profile: profile({}),
      companionPath: null,
      companion: null,
      gpus: [gpu],
      usage: [{ cudaIndex: 0, dedicatedMb: 0, otherMb: 1000 }],
      ...over,
    });
    const auto = { c: 131072, ctk: 'q8_0', ctv: 'q8_0' };

    it('writes the plan into a fresh command and remembers it', () => {
      expect(tunePickedManagedChatCommand(facts({}), 'posix')).toEqual({
        command: 'llama-server -m /m/a.gguf --metrics -c 131072 -ctk q8_0 -ctv q8_0',
        autoTuned: auto,
      });
    });

    it('replaces -c 0, which old configs hold', () => {
      expect(tunePickedManagedChatCommand(facts({ command: 'llama-server -m /m/a.gguf -c 0' }), 'posix').command).toBe(
        'llama-server -m /m/a.gguf -c 131072 -ctk q8_0 -ctv q8_0',
      );
    });

    it('never touches a hand-written -c, -dev or --tensor-split', () => {
      const command = 'llama-server -m /m/a.gguf -c 128000 -dev CUDA0,CUDA1 --tensor-split 27,21';
      expect(tunePickedManagedChatCommand(facts({ command }), 'posix')).toEqual({ command, autoTuned: undefined });
      expect(tunePickedManagedChatCommand(facts({ command, autoTuned: auto }), 'posix')).toEqual({ command, autoTuned: auto });
    });

    it('moves its own last choice in place, and stays still when the plan has not changed', () => {
      const command = 'llama-server -m /m/a.gguf -c 65536 -ctk q8_0 -ctv q8_0 --metrics';
      const tuned = tunePickedManagedChatCommand(facts({ command, autoTuned: { ...auto, c: 65536 } }), 'posix');
      expect(tuned.command).toBe('llama-server -m /m/a.gguf -c 131072 -ctk q8_0 -ctv q8_0 --metrics');
      expect(tuned.autoTuned).toEqual(auto);
      expect(tunePickedManagedChatCommand(facts({ command: tuned.command, autoTuned: auto }), 'posix')).toEqual(tuned);
    });

    it('keeps a cache type the user wrote, and does not claim it as its own', () => {
      const tuned = tunePickedManagedChatCommand(facts({ command: 'llama-server -m /m/a.gguf -ctk f16 -ctv f16' }), 'posix');
      expect(tuned.command).toBe('llama-server -m /m/a.gguf -ctk f16 -ctv f16 -c 131072');
      expect(tuned.autoTuned).toEqual({ c: 131072, ctk: '', ctv: '' });
      expect(tunePickedManagedChatCommand(facts({ command: tuned.command, autoTuned: tuned.autoTuned }), 'posix').command).toBe(
        tuned.command,
      );
    });

    it('replaces its own q8 when the next model cannot use it', () => {
      const command = 'llama-server -m /m/b.gguf -c 131072 -ctk q8_0 -ctv q8_0';
      const tuned = tunePickedManagedChatCommand(
        facts({ command, autoTuned: auto, profile: profile({ cacheLengths: [100] }) }),
        'posix',
      );
      expect(tuned.command).toBe('llama-server -m /m/b.gguf -c 131072 -ctk f16 -ctv f16');
    });

    describe('with no plan to replace its own q8', () => {
      const noQ8 = profile({ cacheLengths: [80] });

      it('takes it out under a hand-written -c when the next model cannot load it', () => {
        const command = 'llama-server -m /m/phi.gguf -c 64000 -ctk q8_0 -ctv q8_0';
        expect(tunePickedManagedChatCommand(facts({ command, autoTuned: auto, profile: noQ8 }), 'posix')).toEqual({
          command: 'llama-server -m /m/phi.gguf -c 64000',
          autoTuned: { ...auto, ctk: '', ctv: '' },
        });
      });

      it('takes it out before the cards are known too', () => {
        const command = 'llama-server -m /m/phi.gguf -c 131072 -ctk q8_0 -ctv q8_0';
        expect(tunePickedManagedChatCommand(facts({ command, autoTuned: auto, profile: noQ8, gpus: [] }), 'posix')).toEqual({
          command: 'llama-server -m /m/phi.gguf -c 131072',
          autoTuned: { ...auto, ctk: '', ctv: '' },
        });
      });

      it('keeps it under a hand-written -c on a model that can load it', () => {
        const command = 'llama-server -m /m/a.gguf -c 64000 -ctk q8_0 -ctv q8_0';
        expect(tunePickedManagedChatCommand(facts({ command, autoTuned: auto }), 'posix')).toEqual({ command, autoTuned: auto });
      });

      it('leaves q8 the user wrote, for the editor to flag', () => {
        const command = 'llama-server -m /m/phi.gguf -c 64000 -ctk q8_0 -ctv q8_0';
        expect(tunePickedManagedChatCommand(facts({ command, profile: noQ8 }), 'posix')).toEqual({ command, autoTuned: undefined });
      });
    });

    it('leaves room for the projector, when its size was read', () => {
      const command = 'llama-server -m /m/a.gguf --mmproj /m/mmproj-BF16.gguf';
      const small: CudaGpuDevice = { ...gpu, memoryTotalMb: 12288 };
      const usage = [{ cudaIndex: 0, dedicatedMb: 0, otherMb: 0 }];
      const unread = tunePickedManagedChatCommand(facts({ command, gpus: [small], usage, projectorBytes: null }), 'posix').autoTuned?.c;
      const read = tunePickedManagedChatCommand(facts({ command, gpus: [small], usage, projectorBytes: 2 * 1024 ** 3 }), 'posix').autoTuned?.c;
      expect(read).toBeLessThan(unread ?? 0);
    });

    it('takes out its own choice when the new model has no plan, so --fit can shrink the context', () => {
      const command = 'llama-server -m /m/big.gguf -c 131072 -ctk q8_0 -ctv q8_0 --metrics';
      const big = profile({ tensorBytes: 40 * 1024 ** 3 });
      expect(tunePickedManagedChatCommand(facts({ command, autoTuned: auto, profile: big }), 'posix')).toEqual({
        command: 'llama-server -m /m/big.gguf --metrics',
        autoTuned: undefined,
      });
    });

    it('leaves the command alone until the cards are known', () => {
      const command = 'llama-server -m /m/a.gguf -c 65536 -ctk q8_0 -ctv q8_0';
      const autoTuned = { ...auto, c: 65536 };
      expect(tunePickedManagedChatCommand(facts({ command, autoTuned, gpus: [] }), 'posix')).toEqual({ command, autoTuned });
    });

    it('restores draft-mtp when the user had it and the new model has a head', () => {
      const previous = 'llama-server -m /m/old.gguf --spec-type draft-mtp -c 8192';
      const command = 'llama-server -m /m/a.gguf -c 8192';
      expect(tunePickedManagedChatCommand(facts({ command, previous }), 'posix').command).toBe(command);
      expect(tunePickedManagedChatCommand(facts({ command, previous, profile: profile({ nextnLayers: 1 }) }), 'posix').command).toBe(
        `${command} --spec-type draft-mtp --spec-draft-n-max 4`,
      );
      expect(tunePickedManagedChatCommand(facts({ command, previous, companionPath: path, companion }), 'posix').command).toBe(
        `${command} --spec-type draft-mtp --spec-draft-model ${path} --spec-draft-n-max 4`,
      );
    });

    it('never turns MTP on by itself', () => {
      const command = 'llama-server -m /m/a.gguf -c 8192';
      const previous = 'llama-server -m /m/old.gguf -c 8192';
      expect(tunePickedManagedChatCommand(facts({ command, previous, companionPath: path, companion }), 'posix').command).toBe(command);
      expect(tunePickedManagedChatCommand(facts({ command, previous, profile: profile({ nextnLayers: 1 }) }), 'posix').command).toBe(command);
    });

    it('plans around the head it restores', () => {
      const small: CudaGpuDevice = { ...gpu, memoryTotalMb: 12288 };
      const previous = 'llama-server -m /m/old.gguf --spec-type draft-mtp';
      const command = 'llama-server -m /m/a.gguf';
      const headless = tunePickedManagedChatCommand(facts({ command, gpus: [small], usage: [] }), 'posix').autoTuned?.c ?? 0;
      const withHead = tunePickedManagedChatCommand(
        facts({ command, previous, companionPath: path, companion, gpus: [small], usage: [] }),
        'posix',
      ).autoTuned?.c;
      expect(withHead).toBeLessThan(headless);
    });
  });
});

describe('ensureManagedLlamaGemmaReasoningFormat', () => {
  it('appends --reasoning-format none when missing', () => {
    expect(ensureManagedLlamaGemmaReasoningFormat('llama-server --jinja --port {{PORT}}')).toBe(
      'llama-server --jinja --port {{PORT}} --reasoning-format none',
    );
  });

  it('does not override an existing --reasoning-format', () => {
    const cmd = 'llama-server --jinja --reasoning-format deepseek --port {{PORT}}';
    expect(ensureManagedLlamaGemmaReasoningFormat(cmd)).toBe(cmd);
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
      parallelToolCalls: true,
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
      parallelToolCalls: true,
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

describe('outerAgentBriefEnabled', () => {
  it('is true for every optimization preset', () => {
    expect(outerAgentBriefEnabled('gemma')).toBe(true);
    expect(outerAgentBriefEnabled('qwen')).toBe(true);
    expect(outerAgentBriefEnabled('generic')).toBe(true);
    expect(outerAgentBriefEnabled(undefined)).toBe(true);
  });
});
