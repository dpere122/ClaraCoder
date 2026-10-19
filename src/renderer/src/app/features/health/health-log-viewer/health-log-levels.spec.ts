import { describe, expect, it } from 'vitest';
import type { HealthLogRecord } from '@shared/index';
import { countHealthLogBuckets, healthLogBucket } from './health-log-levels';

function rec(level: string): HealthLogRecord {
  return { seq: 1, ts: 0, level, logger: 'test', message: '', source: 'python' };
}

describe('healthLogBucket', () => {
  it('folds Python level names into the four chip buckets', () => {
    expect(healthLogBucket('CRITICAL')).toBe('ERROR');
    expect(healthLogBucket('warn')).toBe('WARNING');
    expect(healthLogBucket('TRACE')).toBe('DEBUG');
    expect(healthLogBucket('SOMETHING')).toBe('INFO');
    expect(healthLogBucket('')).toBe('INFO');
  });
});

describe('countHealthLogBuckets', () => {
  it('counts records per bucket', () => {
    const counts = countHealthLogBuckets([rec('ERROR'), rec('CRITICAL'), rec('INFO'), rec('DEBUG'), rec('WARNING')]);
    expect(counts).toEqual({ ERROR: 2, WARNING: 1, INFO: 1, DEBUG: 1 });
  });
});
