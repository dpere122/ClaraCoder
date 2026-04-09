import { describe, expect, it } from 'vitest';
import { computeVirtualRange, sumHeights } from './virtual-scroll-range';

describe('virtual-scroll-range', () => {
  it('computeVirtualRange includes buffer around viewport', () => {
    const heights = [50, 50, 50, 50, 50, 50, 50, 50];
    const { start, end } = computeVirtualRange(heights, 100, 80, 40, 32);
    expect(start).toBeLessThan(3);
    expect(end).toBeGreaterThan(3);
    expect(end - start).toBeLessThanOrEqual(heights.length);
  });

  it('sumHeights sums a slice', () => {
    expect(sumHeights([10, 20, 30], 0, 2)).toBe(30);
    expect(sumHeights([10, 20, 30], 1, 3)).toBe(50);
  });
});
