import { describe, expect, it } from 'vitest';
import {
  cudaDeviceListArg,
  estimateManagedLlamaVram,
  estimateProfileMb,
  formatGpuVramGb,
  ggufProfileAllowsQuantizedCache,
  managedLlamaKvCacheWeight,
  overcommittedCards,
  parseManagedLlamaGpuOffload,
  planManagedLlamaTuning,
  recommendGpuOffload,
  shortCudaGpuName,
  syncGpuOffloadInManagedChatCommand,
  syncTensorSplitSliderInManagedChatCommand,
  tensorSplitForGpus,
  tensorSplitSliderForCommand,
  type CudaGpuDevice,
  type GgufProfile,
} from '@shared/index';

const rtx5090: CudaGpuDevice = { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5090', memoryTotalMb: 32187 };
const rtx5070ti: CudaGpuDevice = { cudaIndex: 1, model: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 15995 };

/** Header values of real models. gguf-profile.spec.ts checks them against measured loads. */
const mimo: GgufProfile = {
  contextTrain: 262144,
  embeddingOut: 4096,
  nextnLayers: 0,
  tensorBytes: 9516533760,
  hostBytes: 1080688640,
  headBytes: 0,
  recurrentStateBytes: 52690944,
  fullKeys: 8192,
  fullValues: 8192,
  maxFullKey: 1024,
  swaKeys: 0,
  swaValues: 0,
  slidingWindow: 0,
  cacheLengths: [256],
};
const gemma12: GgufProfile = {
  contextTrain: 262144,
  embeddingOut: 3840,
  nextnLayers: 0,
  tensorBytes: 7203849728,
  hostBytes: 0,
  headBytes: 0,
  recurrentStateBytes: 0,
  fullKeys: 4096,
  fullValues: 4096,
  maxFullKey: 512,
  swaKeys: 81920,
  swaValues: 81920,
  slidingWindow: 1024,
  cacheLengths: [512, 256],
};
const swift: GgufProfile = {
  contextTrain: 262144,
  embeddingOut: 5120,
  nextnLayers: 1,
  tensorBytes: 25288065024,
  hostBytes: 1042944000,
  headBytes: 351008768,
  recurrentStateBytes: 156893184,
  fullKeys: 16384,
  fullValues: 16384,
  maxFullKey: 1024,
  swaKeys: 0,
  swaValues: 0,
  slidingWindow: 0,
  cacheLengths: [256],
};

describe('recommendGpuOffload', () => {
  it('uses the only GPU when one card is present', () => {
    const advice = recommendGpuOffload([rtx5090], 20 * 1024 * 1024 * 1024, 128000);
    expect(advice?.mode).toBe('single');
    expect(advice?.primaryCudaIndex).toBe(0);
  });

  it('prefers the 5090 alone when a 30B Q4 GGUF fits', () => {
    const advice = recommendGpuOffload([rtx5090, rtx5070ti], 20 * 1024 * 1024 * 1024, 32768);
    expect(advice?.mode).toBe('single');
    expect(advice?.primaryCudaIndex).toBe(0);
    expect(advice?.reason).toMatch(/fits/i);
  });

  it('recommends a VRAM split when weights exceed the largest card', () => {
    const advice = recommendGpuOffload([rtx5090, rtx5070ti], 36 * 1024 * 1024 * 1024, 8192);
    expect(advice?.mode).toBe('split');
    expect(advice?.tensorSplit).toBe('31,16');
    expect(advice?.reason).toMatch(/larger than/i);
  });

  it('defaults to the fastest card when model size is unknown', () => {
    const advice = recommendGpuOffload([rtx5090, rtx5070ti], null, 128000);
    expect(advice?.mode).toBe('single');
    expect(advice?.reason).toMatch(/unknown/i);
  });

  it('treats Max context (-c 0) as a large KV reserve', () => {
    const advice = recommendGpuOffload([rtx5090, rtx5070ti], 22 * 1024 * 1024 * 1024, 0);
    expect(advice?.mode).toBe('split');
  });
});

describe('tensorSplitForGpus / device list', () => {
  it('emits GiB proportions and CUDA ordinals', () => {
    expect(tensorSplitForGpus([rtx5090, rtx5070ti])).toBe('31,16');
    expect(cudaDeviceListArg([rtx5090, rtx5070ti])).toBe('CUDA0,CUDA1');
    expect(shortCudaGpuName(rtx5090.model)).toBe('RTX 5090');
    expect(formatGpuVramGb(32187)).toBe('31 GB');
  });
});

describe('parseManagedLlamaGpuOffload', () => {
  it('treats a missing -dev as auto', () => {
    expect(parseManagedLlamaGpuOffload('llama-server --port {{PORT}} -ngl 99').mode).toBe('auto');
  });

  it('parses a single device as fastest-card', () => {
    const p = parseManagedLlamaGpuOffload('llama-server -dev CUDA1 --main-gpu 1 --port {{PORT}}');
    expect(p.mode).toBe('single');
    expect(p.cudaIndexes).toEqual([1]);
    expect(p.mainGpu).toBe(1);
  });

  it('parses multi-device + tensor-split as split', () => {
    const p = parseManagedLlamaGpuOffload(
      'llama-server -dev CUDA0,CUDA1 --tensor-split 32,16 --port {{PORT}}',
    );
    expect(p.mode).toBe('split');
    expect(p.cudaIndexes).toEqual([0, 1]);
    expect(p.tensorSplit).toBe('32,16');
  });
});

describe('syncGpuOffloadInManagedChatCommand', () => {
  const base = 'llama-server --host 127.0.0.1 --port {{PORT}} -m /m.gguf -c 8192 --metrics';

  it('pins the largest GPU for single mode and drops tensor-split', () => {
    const cmd = syncGpuOffloadInManagedChatCommand(
      `${base} -dev CUDA0,CUDA1 --tensor-split 80,20`,
      'single',
      [rtx5090, rtx5070ti],
      'posix',
    );
    expect(cmd).toContain('-dev CUDA0');
    expect(cmd).not.toContain('CUDA1');
    expect(cmd).not.toContain('--tensor-split');
    expect(cmd).not.toContain('--main-gpu');
  });

  it('pins the card it is asked for, and drops a --main-gpu that -dev would put out of range', () => {
    const cmd = syncGpuOffloadInManagedChatCommand(
      `${base} -dev CUDA0 --main-gpu 0`,
      'single',
      [rtx5090, rtx5070ti],
      'posix',
      1,
    );
    expect(cmd).toBe(`${base} -dev CUDA1`);
  });

  it('falls back to the largest card when the card it is asked for is gone', () => {
    expect(syncGpuOffloadInManagedChatCommand(base, 'single', [rtx5090, rtx5070ti], 'posix', 7)).toBe(`${base} -dev CUDA0`);
  });

  it('writes VRAM-weighted split flags', () => {
    const cmd = syncGpuOffloadInManagedChatCommand(base, 'split', [rtx5090, rtx5070ti], 'posix');
    expect(cmd).toContain('-dev CUDA0,CUDA1');
    expect(cmd).toContain('--tensor-split 31,16');
    expect(cmd).toContain('--main-gpu 0');
  });

  it('strips placement flags for auto', () => {
    const cmd = syncGpuOffloadInManagedChatCommand(
      `${base} -dev CUDA0 --main-gpu 0 --tensor-split 31,16`,
      'auto',
      [rtx5090, rtx5070ti],
      'posix',
    );
    expect(cmd).not.toContain('-dev');
    expect(cmd).not.toContain('--tensor-split');
    expect(cmd).not.toContain('--main-gpu');
    expect(cmd).toContain('--metrics');
  });

  it('selects CUDA1 when that card has more VRAM', () => {
    const swapped: CudaGpuDevice[] = [
      { ...rtx5070ti, cudaIndex: 0 },
      { ...rtx5090, cudaIndex: 1 },
    ];
    const cmd = syncGpuOffloadInManagedChatCommand(base, 'single', swapped, 'posix');
    expect(cmd).toContain('-dev CUDA1');
    expect(cmd).not.toContain('--main-gpu');
  });

  it('leaves the command unchanged when GPUs are unknown', () => {
    const cmd = `${base} -dev CUDA0 --main-gpu 0`;
    expect(syncGpuOffloadInManagedChatCommand(cmd, 'single', [], 'posix')).toBe(cmd);
  });
});

describe('tensor split slider', () => {
  const gpus = [rtx5090, rtx5070ti];
  const cmd = (extra: string) => `llama-server --port {{PORT}} -m a.gguf -dev CUDA0,CUDA1 ${extra}`.trim();

  it('reads the current split in GB out of both cards', () => {
    const slider = tensorSplitSliderForCommand(cmd('--tensor-split 36,12'), gpus);
    expect(slider?.total).toBe(47);
    expect(slider?.value).toBe(35);
    expect(slider?.first).toBe(rtx5090);
    expect(slider?.second).toBe(rtx5070ti);
  });

  it('maps any ratio onto the slider, and starts from VRAM when no split is set', () => {
    expect(tensorSplitSliderForCommand(cmd('-ts 3,1'), gpus)?.value).toBe(35);
    expect(tensorSplitSliderForCommand(cmd('-ts 0.5,0.5'), gpus)?.value).toBe(24);
    expect(tensorSplitSliderForCommand(cmd(''), gpus)?.value).toBe(31);
  });

  it('keeps both cards in the split at the ends of the range', () => {
    expect(tensorSplitSliderForCommand(cmd('-ts 1000,1'), gpus)?.value).toBe(46);
    expect(tensorSplitSliderForCommand(cmd('-ts 1,1000'), gpus)?.value).toBe(1);
  });

  it('follows the -dev order', () => {
    const slider = tensorSplitSliderForCommand('llama-server -dev CUDA1,CUDA0 -ts 12,36', gpus);
    expect(slider?.first).toBe(rtx5070ti);
    expect(slider?.value).toBe(12);
  });

  it('has no slider for what it cannot express', () => {
    expect(tensorSplitSliderForCommand('llama-server -dev CUDA0', gpus)).toBeNull();
    expect(tensorSplitSliderForCommand('llama-server -m a.gguf', gpus)).toBeNull();
    expect(tensorSplitSliderForCommand(cmd('-ts 1,2,3'), gpus)).toBeNull();
    expect(tensorSplitSliderForCommand(cmd('-ts 0,1'), gpus)).toBeNull();
    expect(tensorSplitSliderForCommand(cmd('-ts abc'), gpus)).toBeNull();
    expect(tensorSplitSliderForCommand('llama-server -dev CUDA0,CUDA5', gpus)).toBeNull();
  });

  it('writes the split in place, keeping the alias as written', () => {
    expect(syncTensorSplitSliderInManagedChatCommand(cmd('-ts 3,1 --metrics'), 30, 47, 'posix')).toBe(
      cmd('-ts 30,17 --metrics'),
    );
    expect(syncTensorSplitSliderInManagedChatCommand(cmd(''), 30, 47, 'posix')).toBe(cmd('--tensor-split 30,17'));
  });
});

describe('VRAM estimate', () => {
  /** Measured on an RTX 5090 + 5070 Ti driving a 5120x2160 desktop, with Qwen3.8-27B Q6. */
  const gpus: CudaGpuDevice[] = [
    { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5090', memoryTotalMb: 32607 },
    { cudaIndex: 1, model: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 16303 },
  ];
  const modelBytes = 24128 * 1024 * 1024;
  const usage = [
    { cudaIndex: 0, dedicatedMb: 11050, otherMb: 11050 },
    { cudaIndex: 1, dedicatedMb: 0, otherMb: 0 },
  ];
  const cmd = (flags: string) => `llama-server --port {{PORT}} -m a.gguf -ctk q8_0 -ctv q8_0 ${flags}`;

  it('flags the split and context that lagged the desktop', () => {
    const cards = estimateManagedLlamaVram(cmd('-c 262144 -dev CUDA0,CUDA1 --tensor-split 36,12'), gpus, modelBytes, usage);
    expect(cards?.[0]?.level).toBe('over');
    expect(cards?.[1]?.level).toBe('ok');
    // Measured: 24.97 GB of model on the 5090. The estimate should be close, and not below it.
    const modelGb = (cards?.[0]?.modelMb ?? 0) / 1024;
    expect(modelGb).toBeGreaterThan(24.9);
    expect(modelGb).toBeLessThan(28);
  });

  it('accepts the split and context that fit, within a little headroom', () => {
    const cards = estimateManagedLlamaVram(cmd('-c 131072 -dev CUDA0,CUDA1 --tensor-split 32,16'), gpus, modelBytes, usage);
    expect(cards?.[0]?.level).not.toBe('over');
    // Measured: about 19.5 GB of model on the 5090.
    expect((cards?.[0]?.modelMb ?? 0) / 1024).toBeGreaterThan(19);
    expect((cards?.[0]?.modelMb ?? 0) / 1024).toBeLessThan(21.5);
  });

  it('marks a fit with little room as tight', () => {
    const roomy = [{ cudaIndex: 0, dedicatedMb: 0, otherMb: 11900 }];
    const cards = estimateManagedLlamaVram(cmd('-c 131072 -dev CUDA0,CUDA1 --tensor-split 32,16'), gpus, modelBytes, roomy);
    expect(cards?.[0]?.level).toBe('tight');
  });

  it('puts everything on the one card a single-card command names', () => {
    const cards = estimateManagedLlamaVram(cmd('-c 262144 -dev CUDA0'), gpus, modelBytes, usage);
    expect(cards).toHaveLength(1);
    expect(cards?.[0]?.level).toBe('over');
  });

  it('counts an unquantized KV cache at twice the size', () => {
    const q8 = estimateManagedLlamaVram(cmd('-c 131072 -dev CUDA0'), gpus, modelBytes, [])?.[0]?.modelMb ?? 0;
    const f16 = estimateManagedLlamaVram('llama-server -m a.gguf -c 131072 -dev CUDA0', gpus, modelBytes, [])?.[0]?.modelMb ?? 0;
    expect(f16 - q8).toBeCloseTo(128 * 42, 0);
  });

  it('assumes a large context for -c 0', () => {
    const native = estimateManagedLlamaVram(cmd('-c 0 -dev CUDA0'), gpus, modelBytes, [])?.[0]?.modelMb;
    const big = estimateManagedLlamaVram(cmd('-c 262144 -dev CUDA0'), gpus, modelBytes, [])?.[0]?.modelMb;
    expect(native).toBe(big);
  });

  it('has no estimate without a size, cards, or GPU layers', () => {
    expect(estimateManagedLlamaVram(cmd('-c 1'), gpus, null, usage)).toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1'), [], modelBytes, usage)).toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1 -ngl 0'), gpus, modelBytes, usage)).toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1 -dev CUDA7'), gpus, modelBytes, usage)).toBeNull();
  });

  it('has no estimate when the command does not spread the model over CUDA cards', () => {
    expect(estimateManagedLlamaVram(cmd('-c 1 -ngl 10'), gpus, modelBytes, usage)).toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1 -dev none'), gpus, modelBytes, usage)).toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1 -dev Vulkan0'), gpus, modelBytes, usage)).toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1 -sm none'), gpus, modelBytes, usage)).toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1 --split-mode none'), gpus, modelBytes, usage)).toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1 -ngl auto'), gpus, modelBytes, usage)).not.toBeNull();
    expect(estimateManagedLlamaVram(cmd('-c 1 -ngl 99'), gpus, modelBytes, usage)).not.toBeNull();
  });

  it('agrees with the recommendation about an unquantized cache', () => {
    const size = 20 * 1024 * 1024 * 1024;
    const command = 'llama-server -m a.gguf -c 131072 -dev CUDA0';
    const single = estimateManagedLlamaVram(command, gpus, size, [])?.[0];
    expect(single?.level).toBe('over');
    const advice = recommendGpuOffload(gpus, size, 131072, [], managedLlamaKvCacheWeight(command));
    expect(advice?.mode).toBe('split');
  });

  it('recommends what actually fits once the desktop is counted', () => {
    const big = recommendGpuOffload(gpus, modelBytes, 262144, usage);
    expect(big?.mode).toBe('split');
    expect(big?.reason).not.toMatch(/fits on/);
    const small = 8 * 1024 * 1024 * 1024;
    expect(recommendGpuOffload(gpus, small, 16384, usage)?.mode).toBe('single');
  });

  it('reports only cards allocated past their physical memory', () => {
    const over = overcommittedCards(gpus, [
      { cudaIndex: 0, dedicatedMb: 36600, otherMb: 11000 },
      { cudaIndex: 1, dedicatedMb: 11100, otherMb: 0 },
    ]);
    expect(over.map((c) => c.gpu.cudaIndex)).toEqual([0]);
  });

  describe('from a GGUF header', () => {
    const q8 = (flags: string) => `llama-server -m a.gguf -ctk q8_0 -ctv q8_0 ${flags}`;
    const modelMb = (command: string, profile: GgufProfile, companionHeadBytes?: number): number =>
      estimateManagedLlamaVram(command, [rtx5070ti], null, [], profile, companionHeadBytes)?.[0]?.modelMb ?? 0;
    const options = { c: 65536, ctk: 'q8_0', ctv: 'q8_0', ub: 512, cards: 1, embeddedHead: false };

    it('sizes a command without the file size or the constant per token', () => {
      expect(modelMb(q8('-c 65536 -dev CUDA1'), mimo)).toBeCloseTo(estimateProfileMb(mimo, options), 6);
      // Bytes from the header, where the constant says 42 MiB per 1024 tokens for every model.
      const mbPer1kTokens = (modelMb(q8('-c 131072 -dev CUDA1'), mimo) - modelMb(q8('-c 65536 -dev CUDA1'), mimo)) / 64;
      expect(mbPer1kTokens).toBeCloseTo(22, 3);
    });

    it('reads the cache types, -ub and -b from the command', () => {
      expect(modelMb('llama-server -m a.gguf -c 65536', mimo)).toBeCloseTo(
        estimateProfileMb(mimo, { ...options, ctk: 'f16', ctv: 'f16' }),
        6,
      );
      expect(modelMb(q8('-c 65536 -ub 1024'), mimo)).toBeCloseTo(estimateProfileMb(mimo, { ...options, ub: 1024 }), 6);
      // llama.cpp uses the batch size when -ub is larger.
      expect(modelMb(q8('-c 65536 -ub 1024 -b 256'), mimo)).toBeCloseTo(estimateProfileMb(mimo, { ...options, ub: 256 }), 6);
    });

    it('takes the model context for -c 0 and no -c, not an assumed 262144', () => {
      const small = { ...mimo, contextTrain: 32768 };
      expect(modelMb(q8('-c 0'), small)).toBeCloseTo(estimateProfileMb(small, { ...options, c: 32768 }), 6);
      expect(modelMb(q8(''), small)).toBeCloseTo(estimateProfileMb(small, { ...options, c: 32768 }), 6);
    });

    it('adds a head in the file only under draft-mtp', () => {
      const without = modelMb(q8('-c 65536'), swift);
      const withHead = modelMb(q8('-c 65536 --spec-type draft-mtp'), swift);
      expect(withHead - without).toBeCloseTo(swift.headBytes / (1024 * 1024), 3);
    });

    it('adds a companion head: its tensors plus a fixed overhead, and not the head in the file', () => {
      const bytes = 227 * 1024 * 1024;
      const without = modelMb(q8('-c 65536'), swift);
      const companion = q8('-c 65536 --spec-type draft-mtp --spec-draft-model /m/mtp.gguf');
      expect(modelMb(companion, swift, bytes) - without).toBeCloseTo(472, 3);
      // Before its header has been read, the part that doesn't depend on the file.
      expect(modelMb(companion, swift) - without).toBeCloseTo(245, 3);
      // A draft model with no draft-mtp is some other kind of speculation.
      expect(modelMb(q8('-c 65536 --spec-draft-model /m/mtp.gguf'), swift, bytes)).toBeCloseTo(without, 3);
    });

    it('charges each card its own buffers and overhead', () => {
      const one = estimateProfileMb(swift, { ...options, cards: 1 });
      const two = estimateProfileMb(swift, { ...options, cards: 2 });
      // 229 + 0.11 * 512 MiB per card, plus (4 * 1024 + 2 * 512) bytes for each of the 65536 tokens.
      expect(two - one).toBeCloseTo(285.32 + 320, 2);
    });

    it('keeps a sliding-window cache to the window, however large -c is', () => {
      const at = (c: number) => estimateProfileMb(gemma12, { ...options, c });
      // Past the window, only the full-attention layers grow with -c.
      expect((at(131072) - at(65536)) / 64).toBeCloseTo(11.5, 3);
      // Below it, the sliding-window cells shrink too.
      expect(at(1024) - at(512)).toBeGreaterThan(50);
    });

    it('lets the header overrule the file size in a recommendation', () => {
      const sizing = { profile: mimo, command: q8('-c 131072') };
      const twoSmallCards = [rtx5070ti, { ...rtx5070ti, cudaIndex: 2 }];
      expect(recommendGpuOffload(twoSmallCards, 20 * 1024 ** 3, 131072, [], 1)?.mode).toBe('split');
      const advice = recommendGpuOffload(twoSmallCards, 20 * 1024 ** 3, 131072, [], 1, sizing);
      expect(advice?.mode).toBe('single');
      expect(advice?.reason).toMatch(/fits on/);
    });

    it('sizes a split on all its cards, and a single card on one', () => {
      const advise = (tensorMb: number) =>
        recommendGpuOffload([rtx5090, rtx5070ti], null, 131072, [], 1, {
          profile: { ...mimo, tensorBytes: tensorMb * 1024 * 1024, hostBytes: 0 },
          command: q8('-c 131072'),
        });
      expect(advise(36864)?.reason).toMatch(/larger than/);
      // Fits both cards' 90% on the one-card size, but not with a second card's buffers and overhead.
      expect(advise(39800)?.mode).toBe('split');
      expect(advise(39800)?.reason).toMatch(/may still be tight/);
    });

    it('still knows when a command does not spread the model over the cards', () => {
      expect(estimateManagedLlamaVram(q8('-c 1 -ngl 10'), gpus, null, [], mimo)).toBeNull();
      expect(estimateManagedLlamaVram(q8('-c 1 -sm none'), gpus, null, [], mimo)).toBeNull();
      expect(estimateManagedLlamaVram(q8('-c 1'), [], null, [], mimo)).toBeNull();
    });
  });
});

describe('planManagedLlamaTuning', () => {
  const card = (memoryTotalMb: number, cudaIndex = 0): CudaGpuDevice => ({ cudaIndex, model: 'GPU', memoryTotalMb });
  const quiet = (cards: CudaGpuDevice[]) => cards.map((g) => ({ cudaIndex: g.cudaIndex, dedicatedMb: 0, otherMb: 0 }));
  const cmd = 'llama-server -m a.gguf';

  it('gives each measured model the ceiling on a 16 GB card', () => {
    const cards = [rtx5070ti];
    expect(planManagedLlamaTuning(mimo, cards, quiet(cards), cmd)).toEqual({ c: 131072, ctk: 'q8_0', ctv: 'q8_0' });
    expect(planManagedLlamaTuning(gemma12, cards, quiet(cards), cmd)).toEqual({ c: 131072, ctk: 'q8_0', ctv: 'q8_0' });
  });

  it('never goes past what the model was trained for', () => {
    expect(planManagedLlamaTuning({ ...mimo, contextTrain: 32768 }, [rtx5070ti], [], cmd)?.c).toBe(32768);
    expect(planManagedLlamaTuning({ ...mimo, contextTrain: 100000 }, [rtx5070ti], [], cmd)?.c).toBe(100000);
    expect(planManagedLlamaTuning({ ...mimo, contextTrain: 8192 }, [rtx5070ti], [], cmd)?.c).toBe(8192);
  });

  it('takes the largest context that leaves the card ok', () => {
    const cards = [card(11264)];
    const plan = planManagedLlamaTuning(mimo, cards, quiet(cards), cmd);
    expect(plan?.c).toBeGreaterThan(16384);
    expect(plan?.c).toBeLessThan(131072);
    expect((plan?.c ?? 0) % 4096).toBe(0);
    const at = (c: number) => estimateManagedLlamaVram(`${cmd} -ctk q8_0 -ctv q8_0 -c ${c}`, cards, null, quiet(cards), mimo)?.[0];
    expect(at(plan?.c ?? 0)?.level).toBe('ok');
    expect(at((plan?.c ?? 0) + 4096)?.level).not.toBe('ok');
  });

  it('counts what the desktop holds, on every card of a hand-written split', () => {
    const cards = [card(32607), card(16303, 1)];
    const split = `${cmd} -dev CUDA0,CUDA1 --tensor-split 27,21`;
    const usage = [
      { cudaIndex: 0, dedicatedMb: 11050, otherMb: 11050 },
      { cudaIndex: 1, dedicatedMb: 0, otherMb: 0 },
    ];
    expect(planManagedLlamaTuning(swift, cards, usage, split)?.c).toBe(131072);
    const secondCardBusy = [usage[0]!, { cudaIndex: 1, dedicatedMb: 3000, otherMb: 3000 }];
    expect(planManagedLlamaTuning(swift, cards, secondCardBusy, split)?.c).toBeLessThan(131072);
  });

  it('reserves 15% of each card when usage could not be read', () => {
    const cards = [card(12288)];
    const known = planManagedLlamaTuning(mimo, cards, quiet(cards), cmd)?.c ?? 0;
    const unknown = planManagedLlamaTuning(mimo, cards, [], cmd)?.c ?? 0;
    expect(unknown).toBeLessThan(known);
    expect(unknown).toBe(planManagedLlamaTuning(mimo, cards, [{ cudaIndex: 0, dedicatedMb: 0, otherMb: 12288 * 0.15 }], cmd)?.c);
  });

  it('plans nothing when even the floor does not fit', () => {
    expect(planManagedLlamaTuning(swift, [rtx5070ti], [], cmd)).toBeNull();
    const cards = [card(10300)];
    expect(planManagedLlamaTuning(mimo, cards, quiet(cards), cmd)).not.toBeNull();
    expect(planManagedLlamaTuning(mimo, cards, [{ cudaIndex: 0, dedicatedMb: 0, otherMb: 1000 }], cmd)).toBeNull();
  });

  it('plans nothing it cannot estimate', () => {
    expect(planManagedLlamaTuning(mimo, [], [], cmd)).toBeNull();
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} -ngl 10`)).toBeNull();
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} -dev none`)).toBeNull();
  });

  it('uses q8 only when the model and flash attention allow it', () => {
    const odd = { ...mimo, cacheLengths: [256, 100] };
    expect(ggufProfileAllowsQuantizedCache(odd)).toBe(false);
    expect(ggufProfileAllowsQuantizedCache(mimo)).toBe(true);
    expect(planManagedLlamaTuning(odd, [rtx5070ti], [], cmd)).toMatchObject({ ctk: 'f16', ctv: 'f16' });
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} -fa off`)).toMatchObject({ ctk: 'f16', ctv: 'f16' });
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} -fa on`)).toMatchObject({ ctk: 'q8_0', ctv: 'q8_0' });
  });

  it('keeps cache types the command sets, and sizes the context for them', () => {
    const cards = [card(11264)];
    const f16 = planManagedLlamaTuning(mimo, cards, quiet(cards), `${cmd} -ctk f16 -ctv f16`);
    expect(f16).toMatchObject({ ctk: 'f16', ctv: 'f16' });
    expect(f16?.c).toBeLessThan(planManagedLlamaTuning(mimo, cards, quiet(cards), cmd)?.c ?? 0);
    expect(planManagedLlamaTuning(mimo, cards, quiet(cards), `${cmd} -ctv f16`)).toMatchObject({ ctk: 'f16', ctv: 'f16' });
  });

  it.each(['0', 'false', 'disabled'])('reads -fa %s as off, like the server', (off) => {
    for (const flag of ['-fa', '--flash-attn']) {
      expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} ${flag} ${off}`)).toMatchObject({ ctk: 'f16', ctv: 'f16' });
    }
  });

  it('gives a lone cache flag a matching partner', () => {
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} -ctk f16`)).toMatchObject({ ctk: 'f16', ctv: 'f16' });
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} -ctk q4_0`)).toMatchObject({ ctk: 'q4_0', ctv: 'q4_0' });
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} --cache-type-v q4_0`)).toMatchObject({ ctk: 'q4_0', ctv: 'q4_0' });
  });

  it('does not copy a quantized type where a quantized V would be fatal', () => {
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} -fa off -ctk q8_0`)).toMatchObject({ ctk: 'q8_0', ctv: 'f16' });
    const odd = { ...mimo, cacheLengths: [100] };
    expect(planManagedLlamaTuning(odd, [rtx5070ti], [], `${cmd} -ctk q8_0`)).toMatchObject({ ctk: 'q8_0', ctv: 'f16' });
  });

  it('keeps both cache flags as written, even when they differ', () => {
    expect(planManagedLlamaTuning(mimo, [rtx5070ti], [], `${cmd} -ctk f16 -ctv q8_0`)).toMatchObject({ ctk: 'f16', ctv: 'q8_0' });
  });

  describe('with a projector', () => {
    const cards = [card(12288)];
    const projector = 1024 ** 3;
    const vision = `${cmd} --mmproj /m/mmproj-BF16.gguf`;

    it('gives up context to leave the card ok with it loaded', () => {
      const without = planManagedLlamaTuning(mimo, cards, quiet(cards), vision)?.c ?? 0;
      const plan = planManagedLlamaTuning(mimo, cards, quiet(cards), vision, undefined, projector);
      expect(plan?.c).toBeLessThan(without);
      const tuned = `${vision} -c ${plan?.c} -ctk q8_0 -ctv q8_0`;
      const loaded = estimateManagedLlamaVram(tuned, cards, null, quiet(cards), mimo, undefined, projector)?.[0];
      expect(loaded?.level).toBe('ok');
      // One step more would not be.
      const next = `${vision} -c ${(plan?.c ?? 0) + 4096} -ctk q8_0 -ctv q8_0`;
      expect(estimateManagedLlamaVram(next, cards, null, quiet(cards), mimo, undefined, projector)?.[0]?.level).toBe('tight');
    });

    it('plans nothing when it no longer fits at the floor', () => {
      const tight = [card(10300)];
      expect(planManagedLlamaTuning(mimo, tight, quiet(tight), vision)).not.toBeNull();
      expect(planManagedLlamaTuning(mimo, tight, quiet(tight), vision, undefined, projector)).toBeNull();
    });

    it('goes on the first card of the command, and only there', () => {
      const both = [card(32607, 0), card(16303, 1)];
      const split = `${vision} -c 65536 -ctk q8_0 -ctv q8_0 -dev CUDA1,CUDA0 --tensor-split 1,1`;
      const before = estimateManagedLlamaVram(split, both, null, quiet(both), mimo) ?? [];
      const after = estimateManagedLlamaVram(split, both, null, quiet(both), mimo, undefined, projector) ?? [];
      expect(after.map((c) => c.gpu.cudaIndex)).toEqual([1, 0]);
      expect((after[0]?.modelMb ?? 0) - (before[0]?.modelMb ?? 0)).toBeCloseTo(1024, 6);
      expect(after[1]?.modelMb).toBe(before[1]?.modelMb);
    });
  });

  it('leaves room for a head the command loads', () => {
    const cards = [card(32607)];
    const usage = [{ cudaIndex: 0, dedicatedMb: 0, otherMb: 5000 }];
    const without = planManagedLlamaTuning(swift, cards, usage, cmd)?.c ?? 0;
    expect(without).toBeGreaterThan(0);
    expect(planManagedLlamaTuning(swift, cards, usage, `${cmd} --spec-type draft-mtp`)?.c).toBeLessThan(without);
    const companion = `${cmd} --spec-type draft-mtp --spec-draft-model /m.gguf`;
    expect(planManagedLlamaTuning(swift, cards, usage, companion, 1024 ** 3)?.c).toBeLessThan(without);
  });
});
