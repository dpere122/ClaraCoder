import * as http from 'http';
import { ipcMain, type WebContents } from 'electron';
import * as si from 'systeminformation';
import type {
  GpuInfo,
  HealthLogRecord,
  HealthMetricsSnapshot,
  RuntimeHealthSnapshot,
} from '../../../shared';
import { defaultDependencyCatalog } from '../../../shared';
import { PYTHON_PORT } from '../../constants';
import { summarizeManagedLlamaRuntime } from '../../llama-server-manager';
import { getPythonSidecarToken, pythonControlFetch } from '../../python/http-client';
import { isPythonHealthy } from '../../python/server';
import { listDependencies } from '../../runtime/dependency-manager';
import { getBundledVtslsEntry } from '../../paths';
import { enumerateGpus, NVIDIA_VENDOR_ID, AMD_VENDOR_ID } from '../../utils/dxgi-gpu';
import { getNvidiaStats, listNvidiaCudaGpus, shutdownNvml } from '../../utils/nvml-gpu';
import { getAmdStats, shutdownAdl } from '../../utils/adl-gpu';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

const PYTHON_URL = `http://127.0.0.1:${PYTHON_PORT}`;

const logSubscribers = new Set<WebContents>();

let streamReq: http.ClientRequest | null = null;
let lastStreamSeq = 0;
let streamBuffer = '';
let healthMetricsEnabled = false;

/** GPU model/VRAM are static; utilization and memoryUsed do not need 1s resolution. */
const GRAPHICS_TTL_MS = 10_000;
/** Charts are visual; ~3s staleness is invisible and cuts net/disk process spawns ~3x. */
const NET_FS_TTL_MS = 3_000;

type MetricCache<T> = {
  value: T | null;
  fetchedAt: number;
  inflight: Promise<T> | null;
};

function emptyMetricCache<T>(): MetricCache<T> {
  return { value: null, fetchedAt: 0, inflight: null };
}

const graphicsCache = emptyMetricCache<Awaited<ReturnType<typeof si.graphics>>>();
const networkCache = emptyMetricCache<Awaited<ReturnType<typeof si.networkStats>>>();
const fsCache = emptyMetricCache<Awaited<ReturnType<typeof si.fsStats>>>();

function resetHealthMetricsCache(): void {
  graphicsCache.value = null;
  graphicsCache.fetchedAt = 0;
  networkCache.value = null;
  networkCache.fetchedAt = 0;
  fsCache.value = null;
  fsCache.fetchedAt = 0;
}

/** Collapse whitespace and lowercase a GPU model name for fuzzy matching. */
function normalizeGpuModel(model: string | null | undefined): string {
  return (model ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Build the per-GPU list. On Windows, DXGI enumerates every adapter spawn-free
 * (model + vendor id + total VRAM, including secondary cards that
 * systeminformation leaves blank). Live stats are then overlaid by vendor
 * pipeline:
 *   - NVIDIA (NVML, nvml.dll): utilization + VRAM used/total for every card.
 *   - AMD (ADL, atiadlxx.dll): utilization for active adapters (display-centric;
 *     an inactive iGPU yields nothing and falls back to DXGI total only).
 *   - other vendors: best-effort overlay from the throttled systeminformation
 *     controllers by model name.
 * On other platforms, systeminformation is the sole source.
 */
function buildGpuList(
  controllers: Array<{ model?: string | null; name?: string | null; utilizationGpu?: number | null; memoryUsed?: number | null; memoryTotal?: number | null; vram?: number | null }>,
): GpuInfo[] {
  if (process.platform === 'win32') {
    const dxgpus = enumerateGpus();
    if (dxgpus.length > 0) {
      const nvmlByModel = getNvidiaStats();
      const amdActive = getAmdStats(); // active AMD adapters, ordinal order

      // systeminformation fallback, keyed by model name (covers non-NVIDIA/AMD
      // vendors and any NVIDIA card NVML didn't report).
      const siByModel = new Map<string, { utilPercent: number | null; memoryUsedMb: number | null }>();
      for (const c of controllers) {
        const key = normalizeGpuModel(c?.model || c?.name);
        if (!key || siByModel.has(key)) continue;
        siByModel.set(key, {
          utilPercent: c?.utilizationGpu ?? null,
          memoryUsedMb: c?.memoryUsed ?? null,
        });
      }

      let amdOrdinal = 0;
      return dxgpus.map((g): GpuInfo => {
        const key = normalizeGpuModel(g.model);
        if (g.vendorId === NVIDIA_VENDOR_ID) {
          const n = nvmlByModel.get(key);
          if (n) {
            return {
              model: g.model,
              utilPercent: n.utilPercent,
              memoryUsedMb: n.memoryUsedMb,
              memoryTotalMb: n.memoryTotalMb ?? g.memoryTotalMb,
            };
          }
        } else if (g.vendorId === AMD_VENDOR_ID) {
          const a = amdActive[amdOrdinal++];
          if (a?.utilPercent != null) {
            return { model: g.model, utilPercent: a.utilPercent, memoryUsedMb: null, memoryTotalMb: g.memoryTotalMb };
          }
        }
        const si = siByModel.get(key);
        return {
          model: g.model,
          utilPercent: si?.utilPercent ?? null,
          memoryUsedMb: si?.memoryUsedMb ?? null,
          memoryTotalMb: g.memoryTotalMb,
        };
      });
    }
  }
  return controllers.map((c) => ({
    model: c?.model || c?.name || null,
    utilPercent: c?.utilizationGpu ?? null,
    memoryUsedMb: c?.memoryUsed ?? null,
    memoryTotalMb: c?.memoryTotal ?? c?.vram ?? null,
  }));
}

/**
 * Refresh at most once per ttlMs. Concurrent ticks share one in-flight fetch.
 * When a stale value exists, return it immediately so a slow Windows probe
 * cannot stall mem/cpu collection.
 */
function getCachedMetric<T>(state: MetricCache<T>, fetch: () => Promise<T>, ttlMs: number): Promise<T> {
  if (state.value !== null && Date.now() - state.fetchedAt < ttlMs) {
    return Promise.resolve(state.value);
  }
  if (!state.inflight) {
    state.inflight = fetch()
      .then((value) => {
        if (healthMetricsEnabled) {
          state.value = value;
          state.fetchedAt = Date.now();
        }
        return value;
      })
      .catch((err: unknown) => {
        if (state.value !== null) {
          return state.value;
        }
        throw err;
      })
      .finally(() => {
        state.inflight = null;
      });
  }
  if (state.value !== null) {
    return Promise.resolve(state.value);
  }
  return state.inflight;
}

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
  if (!enabled) {
    resetHealthMetricsCache();
    shutdownNvml();
    shutdownAdl();
  }
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
    gpus: [],
  };
}

export async function collectHealthMetrics(): Promise<HealthMetricsSnapshot> {
  const now = Date.now();
  if (!healthMetricsEnabled) {
    return emptyHealthSnapshot(now);
  }
  try {
    // Electron's built-in getSystemMemoryInfo calls GlobalMemoryStatusEx directly
    // (no child process), unlike si.mem() which shells out on Windows.
    const memInfo = process.getSystemMemoryInfo();
    const [load, netStats, fsStats, gfx] = await Promise.all([
      si.currentLoad(),
      getCachedMetric(networkCache, () => si.networkStats(), NET_FS_TTL_MS),
      getCachedMetric(fsCache, () => si.fsStats(), NET_FS_TTL_MS),
      getCachedMetric(graphicsCache, () => si.graphics(), GRAPHICS_TTL_MS),
    ]);

    const memoryTotalBytes = memInfo.total > 0 ? memInfo.total * 1024 : 1;
    const memoryFreeBytes = memInfo.free * 1024;
    const memoryUsedBytes = Math.max(memoryTotalBytes - memoryFreeBytes, 0);
    const memoryUsedPercent = memoryTotalBytes > 0 ? (memoryUsedBytes / memoryTotalBytes) * 100 : 0;

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

    const controllers = Array.isArray(gfx?.controllers) ? gfx.controllers : [];
    const gpus = buildGpuList(controllers);

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
      gpus,
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

  ipcMain.handle('gpu-cuda-inventory', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return [] as ReturnType<typeof listNvidiaCudaGpus>;
    }
    return listNvidiaCudaGpus();
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
