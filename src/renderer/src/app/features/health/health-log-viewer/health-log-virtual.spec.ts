import { describe, expect, it } from 'vitest';
import type { HealthLogRecord } from '@shared/index';
import {
  HEALTH_LOG_VIRTUAL_THRESHOLD,
  estimateHealthLogRowHeight,
  healthLogVirtualWindow,
} from './health-log-virtual';

function rec(message: string): HealthLogRecord {
  return {
    seq: 1,
    ts: 0,
    level: 'INFO',
    logger: 'test',
    message,
    source: 'py',
  };
}

describe('health-log-virtual', () => {
  it('estimateHealthLogRowHeight grows with message length', () => {
    const short = estimateHealthLogRowHeight(rec('hi'), 'raw');
    const long = estimateHealthLogRowHeight(rec('x'.repeat(500)), 'raw');
    expect(long).toBeGreaterThan(short);
  });

  it('healthLogVirtualWindow returns all rows below threshold', () => {
    const rows = Array.from({ length: HEALTH_LOG_VIRTUAL_THRESHOLD - 1 }, (_, i) =>
      rec(`m${i}`),
    );
    const heights = rows.map((r) => estimateHealthLogRowHeight(r, 'raw'));
    const win = healthLogVirtualWindow(rows, heights, 0, 400);
    expect(win.slots.length).toBe(rows.length);
    expect(win.topSpacer).toBe(0);
    expect(win.bottomSpacer).toBe(0);
  });

  it('healthLogVirtualWindow windows when above threshold with full heights', () => {
    const n = HEALTH_LOG_VIRTUAL_THRESHOLD + 40;
    const rows = Array.from({ length: n }, (_, i) => rec(`m${i}`));
    const heights = rows.map(() => 30);
    const win = healthLogVirtualWindow(rows, heights, 200, 100);
    expect(win.slots.length).toBeLessThan(n);
    expect(win.topSpacer + win.slots.length * 30 + win.bottomSpacer).toBe(n * 30);
  });
});
