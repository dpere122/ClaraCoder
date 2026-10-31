import { describe, expect, it } from 'vitest';
import { formatBytes, formatEta, nextSpeedSample, progressView } from './dependency-progress';

const MB = 1024 * 1024;

describe('nextSpeedSample', () => {
  it('needs two samples before it reports a rate', () => {
    const first = nextSpeedSample(undefined, 0, 1000);
    expect(first.bps).toBeNull();
    const second = nextSpeedSample(first, 10 * MB, 2000);
    expect(second.bps).toBe(10 * MB);
  });

  it('ignores samples that are too close together and smooths the rest', () => {
    const a = { t: 0, bytes: 0, bps: 10 * MB };
    expect(nextSpeedSample(a, 1 * MB, 100)).toBe(a);
    const b = nextSpeedSample(a, 20 * MB, 1000);
    expect(b.bps).toBeCloseTo(10 * MB * 0.7 + 20 * MB * 0.3);
  });

  it('restarts when a new file begins (byte count drops)', () => {
    expect(nextSpeedSample({ t: 0, bytes: 50 * MB, bps: 5 * MB }, 1 * MB, 1000).bps).toBeNull();
  });
});

describe('formatting', () => {
  it('formats sizes and ETAs', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(61.2 * MB)).toBe('61.2 MB');
    expect(formatBytes(3 * 1024 * MB)).toBe('3.00 GB');
    expect(formatEta(4.2)).toBe('~4 s left');
    expect(formatEta(150)).toBe('~3 min left');
    expect(formatEta(3900)).toBe('~1 h 5 min left');
  });
});

describe('progressView', () => {
  it('shows bytes, rate, and time left while downloading', () => {
    const view = progressView(
      { depId: 'llama-server', phase: 'downloading', bytesDone: 50 * MB, bytesTotal: 100 * MB },
      { t: 0, bytes: 50 * MB, bps: 10 * MB },
      null,
    );
    expect(view).toEqual({ phase: 'Downloading', percent: 50, detail: '50.0 MB of 100.0 MB · 10.0 MB/s · ~5 s left' });
  });

  it('falls back to a log percentage outside downloads', () => {
    const view = progressView({ depId: 'kokoro', phase: 'installing' }, undefined, 40);
    expect(view).toEqual({ phase: 'Installing', percent: 40, detail: '' });
  });
});
