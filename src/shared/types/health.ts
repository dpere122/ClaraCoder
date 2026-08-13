import type { DependencyInfo } from './dependencies';
import type { ManagedServerHealthState } from './llama-server-ipc';

/** One GPU controller reported by the OS/driver (best effort). */
export interface GpuInfo {
  model: string | null;
  utilPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
}

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
  /** All detected GPU controllers. */
  gpus: GpuInfo[];
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

/** Aggregated runtime + dependency status for the Health window strip. */
export interface RuntimeHealthSnapshot {
  timestampMs: number;
  python: { healthy: boolean };
  dependencies: DependencyInfo[];
  llama: {
    binaryInstalled: boolean;
    runningCount: number;
    /** Worst chat health among running managed servers, else 'stopped' */
    health: ManagedServerHealthState;
  };
  lsp: {
    javaInstalled: boolean;
    vtslsInstalled: boolean;
    /** Active session managers known to Python, if available; else 0 */
    activeSessions: number;
  };
}
