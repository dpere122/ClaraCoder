import { describe, expect, it } from 'vitest';
import { nvmlLibraryCandidates, parseNvidiaSmiGpuList } from './nvml-gpu';

describe('nvmlLibraryCandidates', () => {
  it('loads nvml.dll on Windows', () => {
    expect(nvmlLibraryCandidates('win32')).toEqual(['nvml.dll']);
  });

  it('tries libnvidia-ml.so.1 and Debian driver paths on Linux', () => {
    const names = nvmlLibraryCandidates('linux');
    expect(names[0]).toBe('libnvidia-ml.so.1');
    expect(names).toContain('/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1');
    expect(names).toContain('/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-ml.so.1');
  });

  it('has no NVML library on macOS', () => {
    expect(nvmlLibraryCandidates('darwin')).toEqual([]);
  });
});

describe('parseNvidiaSmiGpuList', () => {
  it('parses CUDA index, name, and VRAM MiB', () => {
    const csv = [
      '0, NVIDIA GeForce RTX 5090, 32607',
      '1, NVIDIA GeForce RTX 5070 Ti, 16303',
    ].join('\n');
    expect(parseNvidiaSmiGpuList(csv)).toEqual([
      { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5090', memoryTotalMb: 32607 },
      { cudaIndex: 1, model: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 16303 },
    ]);
  });

  it('keeps commas inside the model name', () => {
    expect(parseNvidiaSmiGpuList('0, NVIDIA, Foo GPU, 8192')).toEqual([
      { cudaIndex: 0, model: 'NVIDIA, Foo GPU', memoryTotalMb: 8192 },
    ]);
  });

  it('skips tiny VRAM and malformed rows', () => {
    const csv = [
      '0, NVIDIA GeForce RTX 5090, 32607',
      '1, NVIDIA Dummy, 512',
      'not-a-row',
      '',
    ].join('\n');
    expect(parseNvidiaSmiGpuList(csv)).toEqual([
      { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5090', memoryTotalMb: 32607 },
    ]);
  });
});
