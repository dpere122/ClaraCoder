import { describe, expect, it } from 'vitest';
import { SPARK_H, fmtBytesPerSec, fmtMb, gpuVramLabel, gpuVramPercent, sparklinePaths } from './health-format';

describe('health formatting', () => {
  it('formats byte rates', () => {
    expect(fmtBytesPerSec(512)).toBe('512 B/s');
    expect(fmtBytesPerSec(2048)).toBe('2.0 KB/s');
    expect(fmtBytesPerSec(3 * 1024 * 1024)).toBe('3.00 MB/s');
    expect(fmtBytesPerSec(Number.NaN)).toBe('0 B/s');
  });

  it('formats VRAM in MB or GB', () => {
    expect(fmtMb(512)).toBe('512 MB');
    expect(fmtMb(24576)).toBe('24.0 GB');
  });

  it('derives VRAM percent only when both numbers are reported', () => {
    const gpu = { model: 'x', utilPercent: null, memoryUsedMb: 6144, memoryTotalMb: 24576 };
    expect(gpuVramPercent(gpu)).toBe(25);
    expect(gpuVramLabel(gpu)).toBe('6.0 GB / 24.0 GB');
    expect(gpuVramPercent({ ...gpu, memoryUsedMb: null })).toBeNull();
    expect(gpuVramLabel({ ...gpu, memoryUsedMb: null })).toBe('24.0 GB reported');
  });
});

describe('sparklinePaths', () => {
  it('returns empty paths without data', () => {
    expect(sparklinePaths([], 10)).toEqual({ line: '', area: '' });
  });

  it('right-aligns history and scales to a fixed max', () => {
    const { line, area } = sparklinePaths([0, 100], 3, 100);
    expect(line).toBe(`50.00,${SPARK_H - 1}.00 100.00,1.00`);
    expect(area.startsWith(`M50.00,${SPARK_H}`)).toBe(true);
    expect(area.endsWith(`L100,${SPARK_H} Z`)).toBe(true);
  });

  it('clamps values above the fixed max and treats bad samples as zero', () => {
    const { line } = sparklinePaths([Number.NaN, 250], 2, 100);
    expect(line).toBe(`0.00,${SPARK_H - 1}.00 100.00,1.00`);
  });
});
