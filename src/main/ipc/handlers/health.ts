import * as http from 'http';
import { ipcMain, type WebContents } from 'electron';
import * as si from 'systeminformation';
import type { HealthLogRecord, HealthMetricsSnapshot, RuntimeHealthSnapshot } from '../../../shared';
import { defaultDependencyCatalog } from '../../../shared';
import { PYTHON_PORT } from '../../constants';
import { summarizeManagedLlamaRuntime } from '../../llama-server-manager';
import { getPythonSidecarToken, pythonControlFetch } from '../../python/http-client';
import { isPythonHealthy } from '../../python/server';
import { listDependencies } from '../../runtime/dependency-manager';
import { getBundledVtslsEntry } from '../../paths';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

const PYTHON_URL = `http://127.0.0.1:${PYTHON_PORT}`;

const logSubscribers = new Set<WebContents>();

let streamReq: http.ClientRequest | null = null;
let lastStreamSeq = 0;
let streamBuffer = '';
let healthMetricsEnabled = false;

function broadcastLogRecord(rec: HealthLogRecord): void {
  if (typeof rec.seq === 'number' && rec.seq > lastStreamSeq) {
    lastStreamSeq = rec.seq;
  }
  for (const wc of logSubscribers) {
    if (wc.isDestroyed()) {
      logSubscribers.delete(wc);
      continue;
    }
    try {
      wc.send('health-log-record', rec);
    } catch {
      logSubscribers.delete(wc);
    }
  }
}

function parseSseChunks(raw: string): { lines: HealthLogRecord[]; rest: string } {
  const lines: HealthLogRecord[] = [];
  const parts = raw.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const block of parts) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    try {
      lines.push(JSON.parse(dataLine.slice(6)) as HealthLogRecord);
    } catch {
      // ignore malformed
    }
  }
  return { lines, rest };
}

function stopLogStream(): void {
  if (streamReq) {
    streamReq.destroy();
    streamReq = null;
  }
  streamBuffer = '';
}

function startLogStreamIfNeeded(): void {
  if (logSubscribers.size === 0) {
    stopLogStream();
    return;
  }
  if (streamReq) return;

  const u = new URL(`${PYTHON_URL}/logs/stream`);
  u.searchParams.set('since', String(lastStreamSeq));

  const streamHeaders: http.OutgoingHttpHeaders = {};
  const token = getPythonSidecarToken();
  if (token) {
    streamHeaders.authorization = `Bearer ${token}`;
  }
  streamReq = http.get(u, { headers: streamHeaders }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      streamBuffer += chunk;
      const { lines, rest } = parseSseChunks(streamBuffer);
      streamBuffer = rest;
      for (const rec of lines) {
        broadcastLogRecord(rec);
      }
    });
    res.on('end', () => {
      streamReq = null;
      setTimeout(() => startLogStreamIfNeeded(), logSubscribers.size > 0 ? 400 : 0);
    });
    res.on('error', () => {
      streamReq = null;
      setTimeout(() => startLogStreamIfNeeded(), logSubscribers.size > 0 ? 2000 : 0);
    });
  });
  streamReq.on('error', () => {
    streamReq = null;
    setTimeout(() => startLogStreamIfNeeded(), logSubscribers.size > 0 ? 2000 : 0);
  });
}

/** POST /logs/level — call after Python is up (e.g. from loaded config). */
export async function syncPythonLogLevel(level: string): Promise<void> {
  try {
    await pythonControlFetch('/logs/level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
  } catch {
    // Python not ready
  }
}

export function setHealthMetricsEnabled(enabled: boolean): void {
  healthMetricsEnabled = enabled;
}

function emptyHealthSnapshot(now: number): HealthMetricsSnapshot {
  return {
    timestampMs: now,
    memoryUsedBytes: 0,
    memoryTotalBytes: 1,
    memoryUsedPercent: 0,
    cpuLoadPercent: 0,
    networkRxBps: 0,
    networkTxBps: 0,
    diskReadBps: 0,
    diskWriteBps: 0,
    gpuModel: null,
    gpuUtilPercent: null,
    gpuMemoryUsedMb: null,
    gpuMemoryTotalMb: null,
  };
}

export async function collectHealthMetrics(): Promise<HealthMetricsSnapshot> {
  const now = Date.now();
  if (!healthMetricsEnabled) {
    return emptyHealthSnapshot(now);
  }
  try {
    const [mem, load, netStats, fsStats, gfx] = await Promise.all([
      si.mem(),
      si.currentLoad(),
      si.networkStats(),
      si.fsStats(),
      si.graphics(),
    ]);

    const memoryTotalBytes = mem?.total && mem.total > 0 ? mem.total : 1;
    const memoryUsedBytes = mem?.active ?? mem?.used ?? 0;
    const memoryUsedPercent = (memoryUsedBytes / memoryTotalBytes) * 100;

    let networkRxBps = 0;
    let networkTxBps = 0;
    if (Array.isArray(netStats)) {
      for (const n of netStats) {
        if (!n) continue;
        networkRxBps += n.rx_sec || 0;
        networkTxBps += n.tx_sec || 0;
      }
    }

    const diskReadBps = fsStats?.rx_sec ?? 0;
    const diskWriteBps = fsStats?.wx_sec ?? 0;

    const ctrl = gfx?.controllers?.[0];
    const gpuModel = ctrl?.model || ctrl?.name || null;
    const gpuUtilPercent = ctrl?.utilizationGpu ?? null;
    const gpuMemoryUsedMb = ctrl?.memoryUsed ?? null;
    const gpuMemoryTotalMb = ctrl?.memoryTotal ?? ctrl?.vram ?? null;

    return {
      timestampMs: now,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryUsedPercent,
      cpuLoadPercent: load?.currentLoad ?? 0,
      networkRxBps,
      networkTxBps,
      diskReadBps,
      diskWriteBps,
      gpuModel,
      gpuUtilPercent,
      gpuMemoryUsedMb,
      gpuMemoryTotalMb,
    };
  } catch {
    return emptyHealthSnapshot(now);
  }
}

async function fetchActiveLspSessions(): Promise<number> {
  try {
    if (!(await isPythonHealthy())) return 0;
    const res = await pythonControlFetch('/lsp/sessions');
    if (!res.ok) return 0;
    const body = (await res.json()) as { ok?: boolean; activeSessions?: number };
    return typeof body.activeSessions === 'number' ? body.activeSessions : 0;
  } catch {
    return 0;
  }
}

export async function collectRuntimeHealthSnapshot(): Promise<RuntimeHealthSnapshot> {
  const timestampMs = Date.now();
  const [pythonHealthy, depsResult, llama, activeSessions] = await Promise.all([
    isPythonHealthy(),
    listDependencies().catch(() => ({
      dependencies: defaultDependencyCatalog(),
      error: 'list failed',
    })),
    summarizeManagedLlamaRuntime(),
    fetchActiveLspSessions(),
  ]);
  const dependencies = depsResult.dependencies?.length
    ? depsResult.dependencies
    : defaultDependencyCatalog();
  const javaDep = dependencies.find((d) => d.id === 'java-lsp');
  return {
    timestampMs,
    python: { healthy: pythonHealthy },
    dependencies,
    llama: {
      binaryInstalled: llama.binaryInstalled,
      runningCount: llama.runningCount,
      health: llama.health,
    },
    lsp: {
      javaInstalled: javaDep?.state === 'installed',
      vtslsInstalled: !!getBundledVtslsEntry(),
      activeSessions,
    },
  };
}

export function registerHealthIpc(): void {
  ipcMain.handle('health-metrics', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return emptyHealthSnapshot(Date.now());
    }
    return collectHealthMetrics();
  });

  ipcMain.handle('health-runtime-snapshot', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return {
        timestampMs: Date.now(),
        python: { healthy: false },
        dependencies: defaultDependencyCatalog(),
        llama: { binaryInstalled: false, runningCount: 0, health: 'stopped' as const },
        lsp: { javaInstalled: false, vtslsInstalled: false, activeSessions: 0 },
      };
    }
    return collectRuntimeHealthSnapshot();
  });

  ipcMain.handle('health-logs-recent', async (event, limit: number) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { records: [] as HealthLogRecord[] };
    }
    try {
      const res = await pythonControlFetch(`/logs/recent?limit=${Math.min(2000, Math.max(1, limit || 200))}`);
      if (!res.ok) return { records: [] as HealthLogRecord[] };
      const data = (await res.json()) as { records?: HealthLogRecord[] };
      return { records: data.records ?? [] };
    } catch {
      return { records: [] as HealthLogRecord[] };
    }
  });

  ipcMain.handle('health-set-log-level', async (event, level: string) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    await syncPythonLogLevel(level);
    return { ok: true as const };
  });

  ipcMain.on('health-logs-subscribe', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    const wc = event.sender;
    if (wc.isDestroyed()) return;
    logSubscribers.add(wc);
    wc.once('destroyed', () => {
      logSubscribers.delete(wc);
      if (logSubscribers.size === 0) stopLogStream();
    });
    startLogStreamIfNeeded();
  });

  ipcMain.on('health-logs-unsubscribe', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    logSubscribers.delete(event.sender);
    if (logSubscribers.size === 0) stopLogStream();
  });
}
