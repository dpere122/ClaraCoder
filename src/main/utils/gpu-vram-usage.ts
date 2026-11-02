import { execFile } from 'node:child_process';
import type { GpuVramCardUsage } from '../../shared';

const SAMPLE_TIMEOUT_MS = 10_000;
/** Settings can ask from several places at once; one sample answers them all. */
const SAMPLE_CACHE_MS = 3_000;
const MIB = 1024 * 1024;

/**
 * Per-process VRAM from the Windows GPU counters. Under WDDM ``nvidia-smi`` and the adapter counter
 * under-report: on a card driving a large display, ``dwm`` can hold several GB they don't show.
 * Counter names are localized, so on a non-English Windows this comes back empty and no warning shows.
 */
const SAMPLE_SCRIPT = [
  "$s = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage','\\GPU Adapter Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples",
  '$llama = @(Get-Process -Name llama-server -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
  '@{ samples = @($s | Where-Object { $_.CookedValue -gt 0 } | ForEach-Object { @{ i = $_.InstanceName; v = $_.CookedValue } }); llama = $llama } | ConvertTo-Json -Compress -Depth 4',
].join('; ');

interface AdapterUsage {
  key: string;
  /** Adapter counter: lines up with ``nvidia-smi``, which is how adapters are matched to cards. */
  adapterMb: number;
  dedicatedMb: number;
  llamaMb: number;
}

const ADAPTER_KEY_RE = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+/i;
const PROCESS_PID_RE = /^pid_(\d+)_/i;

/** Parse the counter sample into per-adapter totals. */
export function parseGpuVramSample(json: string): AdapterUsage[] {
  let parsed: { samples?: unknown; llama?: unknown };
  try {
    parsed = JSON.parse(json) as { samples?: unknown; llama?: unknown };
  } catch {
    return [];
  }
  const samples = Array.isArray(parsed.samples) ? (parsed.samples as { i?: unknown; v?: unknown }[]) : [];
  const llama = new Set(Array.isArray(parsed.llama) ? parsed.llama : parsed.llama != null ? [parsed.llama] : []);
  const adapters = new Map<string, AdapterUsage>();
  for (const sample of samples) {
    const instance = String(sample.i ?? '');
    const key = ADAPTER_KEY_RE.exec(instance)?.[1]?.toLowerCase();
    const mb = Number(sample.v) / MIB;
    if (!key || !Number.isFinite(mb)) {
      continue;
    }
    const adapter = adapters.get(key) ?? { key, adapterMb: 0, dedicatedMb: 0, llamaMb: 0 };
    adapters.set(key, adapter);
    const pid = PROCESS_PID_RE.exec(instance)?.[1];
    if (!pid) {
      adapter.adapterMb += mb;
      continue;
    }
    adapter.dedicatedMb += mb;
    if (llama.has(Number(pid))) {
      adapter.llamaMb += mb;
    }
  }
  return [...adapters.values()];
}

/** Parse ``nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits``. */
export function parseNvidiaSmiMemoryUsed(csv: string): { cudaIndex: number; usedMb: number }[] {
  const out: { cudaIndex: number; usedMb: number }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const [index, used] = line.split(',').map((part) => Number.parseInt(part.trim(), 10));
    if (Number.isFinite(index) && Number.isFinite(used)) {
      out.push({ cudaIndex: index as number, usedMb: used as number });
    }
  }
  return out;
}

/**
 * Windows names adapters by LUID and ``nvidia-smi`` by CUDA index. Both report nearly the same used
 * memory for one card, so busiest cards pair with their closest adapter. A card with no adapter
 * within reach is left out rather than guessed.
 */
export function assignAdaptersToCudaCards(
  adapters: readonly AdapterUsage[],
  cards: readonly { cudaIndex: number; usedMb: number }[],
): GpuVramCardUsage[] {
  const free = [...adapters];
  const out: GpuVramCardUsage[] = [];
  for (const card of [...cards].sort((a, b) => b.usedMb - a.usedMb)) {
    let best = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    free.forEach((adapter, i) => {
      const gap = Math.abs(adapter.adapterMb - card.usedMb);
      if (gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    if (best < 0 || bestGap > Math.max(1024, card.usedMb * 0.15)) {
      continue;
    }
    const [adapter] = free.splice(best, 1) as [AdapterUsage];
    out.push({
      cudaIndex: card.cudaIndex,
      dedicatedMb: Math.round(adapter.dedicatedMb),
      otherMb: Math.round(adapter.dedicatedMb - adapter.llamaMb),
    });
  }
  return out.sort((a, b) => a.cudaIndex - b.cudaIndex);
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: SAMPLE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function readUsage(): Promise<GpuVramCardUsage[]> {
  try {
    const [sample, smi] = await Promise.all([
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SAMPLE_SCRIPT]),
      run('nvidia-smi', ['--query-gpu=index,memory.used', '--format=csv,noheader,nounits']),
    ]);
    return assignAdaptersToCudaCards(parseGpuVramSample(sample), parseNvidiaSmiMemoryUsed(smi));
  } catch {
    return [];
  }
}

let cached: { at: number; usage: Promise<GpuVramCardUsage[]> } | null = null;

/** VRAM allocated on each NVIDIA card, by every process. Windows only; elsewhere it's empty. */
export function sampleGpuVramUsage(): Promise<GpuVramCardUsage[]> {
  if (process.platform !== 'win32') {
    return Promise.resolve([]);
  }
  const now = Date.now();
  if (cached && now - cached.at < SAMPLE_CACHE_MS) {
    return cached.usage;
  }
  const usage = readUsage();
  cached = { at: now, usage };
  return usage;
}
