import type { DependencyProgressEvent, DependencyProgressPhase } from '@shared/index';

/** Running download-rate estimate for one dependency. */
export interface SpeedSample {
  /** `Date.now()` of the sample. */
  t: number;
  bytes: number;
  /** Smoothed bytes/second; null until two samples are far enough apart. */
  bps: number | null;
}

/** Samples closer together than this are ignored so the rate doesn't jitter. */
const MIN_SAMPLE_GAP_MS = 400;
/** Weight of the newest measurement in the smoothed rate. */
const RATE_SMOOTHING = 0.3;

/** Fold a new byte count into the rate estimate; a smaller count means a new file started. */
export function nextSpeedSample(prev: SpeedSample | undefined, bytes: number, now: number): SpeedSample {
  if (!prev || bytes < prev.bytes) return { t: now, bytes, bps: null };
  const dtMs = now - prev.t;
  if (dtMs < MIN_SAMPLE_GAP_MS) return prev;
  const instant = ((bytes - prev.bytes) * 1000) / dtMs;
  const bps = prev.bps == null ? instant : prev.bps * (1 - RATE_SMOOTHING) + instant * RATE_SMOOTHING;
  return { t: now, bytes, bps };
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `~${h} h ${m} min left` : `~${h} h left`;
}

const PHASE_LABELS: Partial<Record<DependencyProgressPhase, string>> = {
  queued: 'Starting',
  downloading: 'Downloading',
  extracting: 'Extracting',
  installing: 'Installing',
  finishing: 'Finishing',
  cancelling: 'Cancelling',
};

export interface ProgressView {
  phase: string;
  /** 0–100 when a byte total or a `[NN%]` log line is known. */
  percent: number | null;
  /** `61.2 MB of 145.8 MB · 31.0 MB/s · ~3 s left`, as much as is known. */
  detail: string;
}

/** What the progress row shows for the latest event plus the running rate. */
export function progressView(
  ev: DependencyProgressEvent | undefined,
  speed: SpeedSample | undefined,
  fallbackPercent: number | null,
): ProgressView {
  const phase = (ev && PHASE_LABELS[ev.phase]) ?? 'Working';
  const done = ev?.bytesDone;
  const total = ev?.bytesTotal && ev.bytesTotal > 0 ? ev.bytesTotal : null;
  const bytePercent = done != null && total ? Math.min(100, Math.round((done / total) * 100)) : null;
  const parts: string[] = [];
  if (done != null && ev?.phase === 'downloading') {
    parts.push(total ? `${formatBytes(done)} of ${formatBytes(total)}` : formatBytes(done));
    const bps = speed?.bps;
    if (bps != null && bps > 0) {
      parts.push(`${formatBytes(bps)}/s`);
      if (total && done < total) parts.push(formatEta((total - done) / bps));
    }
  }
  return {
    phase,
    percent: bytePercent ?? fallbackPercent,
    detail: parts.filter(Boolean).join(' · '),
  };
}
