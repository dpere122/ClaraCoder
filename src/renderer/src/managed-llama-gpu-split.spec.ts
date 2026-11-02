import { describe, expect, it } from 'vitest';
import {
  cudaDeviceListArg,
  formatGpuVramGb,
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
