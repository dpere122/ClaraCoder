import { describe, expect, it } from 'vitest';
import { assignAdaptersToCudaCards, parseGpuVramSample, parseNvidiaSmiMemoryUsed } from './gpu-vram-usage';

const GB = 1024 * 1024 * 1024;

/** The numbers from a desktop that lagged with nvidia-smi reporting spare memory. */
const SAMPLE = JSON.stringify({
  llama: [467708],
  samples: [
    { i: 'pid_467708_luid_0x00000000_0x0000ee44_phys_0', v: 24.97 * GB },
    { i: 'pid_467708_luid_0x00000000_0x0001052a_phys_0', v: 10.88 * GB },
    { i: 'pid_349284_luid_0x00000000_0x0000ee44_phys_0', v: 8.61 * GB },
    { i: 'pid_1748_luid_0x00000000_0x0000ee44_phys_0', v: 2.18 * GB },
    { i: 'luid_0x00000000_0x0000ee44_phys_0', v: 27.95 * GB },
    { i: 'luid_0x00000000_0x0001052a_phys_0', v: 10.89 * GB },
  ],
});

describe('parseGpuVramSample', () => {
  it('sums every process per adapter and separates llama-server', () => {
    const adapters = parseGpuVramSample(SAMPLE);
    const main = adapters.find((a) => a.key.endsWith('ee44'));
    expect(main?.dedicatedMb).toBeCloseTo(35.76 * 1024, 0);
    expect(main?.llamaMb).toBeCloseTo(24.97 * 1024, 0);
    expect(main?.adapterMb).toBeCloseTo(27.95 * 1024, 0);
  });

  it('accepts a lone llama pid, which ConvertTo-Json can emit as a scalar', () => {
    const adapters = parseGpuVramSample(
      JSON.stringify({ llama: 7, samples: [{ i: 'pid_7_luid_0x0_0x1_phys_0', v: GB }] }),
    );
    expect(adapters[0]?.llamaMb).toBe(1024);
  });

  it('returns nothing for output it cannot read', () => {
    expect(parseGpuVramSample('not json')).toEqual([]);
    expect(parseGpuVramSample('{}')).toEqual([]);
  });
});

describe('parseNvidiaSmiMemoryUsed', () => {
  it('reads index and used memory, skipping junk', () => {
    expect(parseNvidiaSmiMemoryUsed('0, 28637\r\n1, 11142\n\nbad line\n')).toEqual([
      { cudaIndex: 0, usedMb: 28637 },
      { cudaIndex: 1, usedMb: 11142 },
    ]);
  });
});

describe('assignAdaptersToCudaCards', () => {
  it('matches adapters to cards by used memory, reporting the real allocation', () => {
    const usage = assignAdaptersToCudaCards(parseGpuVramSample(SAMPLE), [
      { cudaIndex: 0, usedMb: 28637 },
      { cudaIndex: 1, usedMb: 11142 },
    ]);
    expect(usage.map((u) => u.cudaIndex)).toEqual([0, 1]);
    expect(usage[0]?.dedicatedMb).toBe(Math.round(35.76 * 1024));
    expect(usage[0]?.otherMb).toBe(Math.round(10.79 * 1024));
    expect(usage[1]?.otherMb).toBe(0);
  });

  it('leaves out a card with no adapter close to it', () => {
    const adapters = [{ key: 'a', adapterMb: 1000, dedicatedMb: 1000, llamaMb: 0 }];
    expect(assignAdaptersToCudaCards(adapters, [{ cudaIndex: 0, usedMb: 28000 }])).toEqual([]);
  });

  it('uses each adapter once', () => {
    const adapters = [{ key: 'a', adapterMb: 100, dedicatedMb: 100, llamaMb: 0 }];
    const usage = assignAdaptersToCudaCards(adapters, [
      { cudaIndex: 0, usedMb: 100 },
      { cudaIndex: 1, usedMb: 100 },
    ]);
    expect(usage).toHaveLength(1);
  });
});
