import { describe, expect, it } from 'vitest';
import {
  cudaDeviceListArg,
  estimateManagedLlamaVram,
  formatGpuVramGb,
  managedLlamaKvCacheWeight,
  overcommittedCards,
  parseManagedLlamaGpuOffload,
  recommendGpuOffload,
  shortCudaGpuName,
  syncGpuOffloadInManagedChatCommand,
  syncTensorSplitSliderInManagedChatCommand,
  tensorSplitForGpus,
  tensorSplitSliderForCommand,
  type CudaGpuDevice,
} from '@shared/index';

const rtx5090: CudaGpuDevice = { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5090', memoryTotalMb: 32187 };
const rtx5070ti: CudaGpuDevice = { cudaIndex: 1, model: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 15995 };

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
    expect(cmd).toContain('--main-gpu 0');
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
    expect(cmd).toContain('--main-gpu 1');
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
});
