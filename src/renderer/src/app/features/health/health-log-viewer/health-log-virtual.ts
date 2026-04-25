import type { HealthLogRecord } from '@shared/index';
import { computeVirtualRange, sumHeights } from '../../../utils/virtual-scroll-range';
import { formatHealthLogMessage, type HealthLogMessageFormat } from './health-log-message.pipe';

/** Rows above this count use windowed rendering. */
export const HEALTH_LOG_VIRTUAL_THRESHOLD = 80;

/** Extra pixels above/below the viewport to keep mounted for smooth scroll. */
export const HEALTH_LOG_VIRTUAL_PIXEL_BUFFER = 720;

/** Fallback row height when a slot has not been measured yet. */
export const HEALTH_MIN_FALLBACK_ROW = 26;

const LINE_PX = 11 * 1.45;

/**
 * Rough height from log row shape (see health-log-viewer.css: grid + mono 11px).
 */
export function estimateHealthLogRowHeight(
  record: HealthLogRecord,
  fmt: HealthLogMessageFormat,
): number {
  const raw = record.message ?? '';
  const msg = fmt === 'raw' ? raw : formatHealthLogMessage(raw, fmt);
  const nl = (msg.match(/\n/g) ?? []).length + 1;
  const cpl = fmt === 'raw' ? 96 : 52;
  const wrapLines = Math.max(nl, Math.ceil(msg.length / cpl));
  const fmtBoost = fmt !== 'raw' ? 1.2 : 1;
  return Math.max(HEALTH_MIN_FALLBACK_ROW, Math.round(8 + wrapLines * LINE_PX * fmtBoost));
}

export function healthLogVirtualWindow(
  rows: readonly HealthLogRecord[],
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
): { slots: { index: number; row: HealthLogRecord }[]; topSpacer: number; bottomSpacer: number } {
  const n = rows.length;
  const h = heights;
  const vh = viewportHeight || 400;

  if (n < HEALTH_LOG_VIRTUAL_THRESHOLD || h.length !== n) {
    return {
      slots: rows.map((row, index) => ({ index, row })),
      topSpacer: 0,
      bottomSpacer: 0,
    };
  }
  const { start, end } = computeVirtualRange(h, scrollTop, vh, HEALTH_LOG_VIRTUAL_PIXEL_BUFFER, HEALTH_MIN_FALLBACK_ROW);
  const slots = rows.slice(start, end).map((row, i) => ({ index: start + i, row }));
  return {
    slots,
    topSpacer: sumHeights(h, 0, start),
    bottomSpacer: sumHeights(h, end, n),
  };
}
