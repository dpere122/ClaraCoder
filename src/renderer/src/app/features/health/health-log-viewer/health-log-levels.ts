import type { HealthLogRecord } from '@shared/index';

/** Display buckets for log level chips; Python levels outside these fold into the nearest one. */
export type HealthLogBucket = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG';

export const HEALTH_LOG_BUCKETS: readonly HealthLogBucket[] = ['ERROR', 'WARNING', 'INFO', 'DEBUG'];

export function healthLogBucket(level: string): HealthLogBucket {
  switch ((level || '').toUpperCase()) {
    case 'ERROR':
    case 'CRITICAL':
    case 'FATAL':
      return 'ERROR';
    case 'WARNING':
    case 'WARN':
      return 'WARNING';
    case 'DEBUG':
    case 'TRACE':
    case 'NOTSET':
      return 'DEBUG';
    default:
      return 'INFO';
  }
}

export function countHealthLogBuckets(records: readonly HealthLogRecord[]): Record<HealthLogBucket, number> {
  const out: Record<HealthLogBucket, number> = { ERROR: 0, WARNING: 0, INFO: 0, DEBUG: 0 };
  for (const r of records) out[healthLogBucket(r.level)]++;
  return out;
}
