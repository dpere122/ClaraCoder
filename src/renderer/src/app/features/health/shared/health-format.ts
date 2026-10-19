import type { GpuInfo } from '@shared/index';

export function fmtBytesPerSec(v: number): string {
  if (!Number.isFinite(v) || v < 0) return '0 B/s';
  if (v < 1024) return `${v.toFixed(0)} B/s`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB/s`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function fmtPercent(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

/** `18432` → `18.0 GB`; small values stay in MB. */
export function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** VRAM use as 0–100, or null when the driver does not report both numbers. */
export function gpuVramPercent(g: GpuInfo): number | null {
  if (g.memoryUsedMb == null || g.memoryTotalMb == null || g.memoryTotalMb <= 0) return null;
  return Math.min(100, Math.max(0, (g.memoryUsedMb / g.memoryTotalMb) * 100));
}

export function gpuVramLabel(g: GpuInfo): string {
  if (g.memoryUsedMb != null && g.memoryTotalMb != null) {
    return `${fmtMb(g.memoryUsedMb)} / ${fmtMb(g.memoryTotalMb)}`;
  }
  if (g.memoryTotalMb != null) return `${fmtMb(g.memoryTotalMb)} reported`;
  return 'not reported';
}

/** Sparkline viewBox is 0..100 × 0..SPARK_H; the SVG stretches it with `preserveAspectRatio="none"`. */
export const SPARK_H = 32;

export interface SparklinePaths {
  /** `points` for the stroke polyline. */
  line: string;
  /** `d` for the filled area under the line. */
  area: string;
}

/**
 * Right-aligned sparkline: the newest sample sits at x=100 and history grows leftwards until
 * `capacity` samples fill the width. `max` pins the scale (percent charts); otherwise it adapts.
 */
export function sparklinePaths(values: readonly number[], capacity: number, max?: number): SparklinePaths {
  if (values.length === 0 || capacity < 2) return { line: '', area: '' };
  const finite = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const top = max ?? Math.max(1, ...finite) * 1.15;
  const step = 100 / (capacity - 1);
  const start = 100 - (finite.length - 1) * step;
  const pts = finite.map((v, i) => {
    const x = start + i * step;
    const y = SPARK_H - 1 - (Math.min(v, top) / top) * (SPARK_H - 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = pts.join(' ');
  const area = `M${start.toFixed(2)},${SPARK_H} L${pts.join(' L')} L100,${SPARK_H} Z`;
  return { line, area };
}
