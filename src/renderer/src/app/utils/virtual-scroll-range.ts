/** Sum row heights in [from, toExclusive). */
export function sumHeights(heights: readonly number[], from: number, toExclusive: number): number {
  let s = 0;
  const end = Math.min(toExclusive, heights.length);
  for (let i = Math.max(0, from); i < end; i++) s += heights[i] ?? 0;
  return s;
}

/**
 * Inclusive start index, exclusive end index, for rows intersecting
 * [scrollTop - buf, scrollTop + viewportHeight + buf].
 */
export function computeVirtualRange(
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  buf: number,
  minFallbackRow: number,
): { start: number; end: number } {
  const n = heights.length;
  if (n === 0) return { start: 0, end: 0 };

  const topLimit = scrollTop - buf;
  const bottomLimit = scrollTop + viewportHeight + buf;

  let cum = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const hi = heights[i] ?? minFallbackRow;
    const rowBottom = cum + hi;
    if (rowBottom > topLimit) {
      start = i;
      break;
    }
    cum = rowBottom;
    if (i === n - 1) start = n - 1;
  }

  cum = sumHeights(heights, 0, start);
  let end = start;
  for (let i = start; i < n; i++) {
    const hi = heights[i] ?? minFallbackRow;
    const rowTop = cum;
    if (rowTop > bottomLimit) break;
    end = i + 1;
    cum += hi;
  }

  return { start, end: Math.max(end, start + 1) };
}
