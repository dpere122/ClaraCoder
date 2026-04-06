/** System snapshot for Health window charts (Electron main → renderer). */
export interface HealthMetricsSnapshot {
  timestampMs: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryUsedPercent: number;
  cpuLoadPercent: number;
  networkRxBps: number;
  networkTxBps: number;
  diskReadBps: number;
  diskWriteBps: number;
  gpuModel: string | null;
  gpuUtilPercent: number | null;
  gpuMemoryUsedMb: number | null;
  gpuMemoryTotalMb: number | null;
}

/** One row from Python `/logs/recent` or SSE `data:` lines. */
export interface HealthLogRecord {
  seq: number;
  ts: number;
  level: string;
  logger: string;
  message: string;
  source: string;
}

export type HealthLogLevel = 'debug' | 'info' | 'warning' | 'error';
