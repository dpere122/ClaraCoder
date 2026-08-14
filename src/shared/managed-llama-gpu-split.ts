/**
 * Recommend and apply llama-server GPU placement: one CUDA card vs a VRAM-weighted split.
 */
import {
  argvToShellCommandLine,
  detectShellQuotingPlatform,
  type ShellQuotingPlatform,
} from './llama-cpp-managed';

/** One NVIDIA device in CUDA / NVML index order. */
export interface CudaGpuDevice {
  cudaIndex: number;
  model: string;
  memoryTotalMb: number;
}

export type ManagedGpuOffloadMode = 'auto' | 'single' | 'split';

export interface GpuOffloadAdvice {
  mode: 'single' | 'split';
  reason: string;
  primaryCudaIndex: number;
  tensorSplit: string;
}

const FIT_RATIO = 0.9;
const COMPUTE_OVERHEAD_MB = 1536;
const MIN_KV_MB = 1024;
const MAX_KV_MB = 12288;
/** Conservative KV guess: ~12 MiB per 1k context tokens. */
const KV_MB_PER_1K_CTX = 12;

function unquoteShellToken(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Dedicated VRAM label for settings copy (32187 MiB → "31 GB"). */
export function formatGpuVramGb(memoryTotalMb: number): string {
  if (!Number.isFinite(memoryTotalMb) || memoryTotalMb <= 0) {
    return '0 GB';
  }
  const gb = memoryTotalMb / 1024;
  if (gb >= 10) {
    return `${Math.round(gb)} GB`;
  }
  return `${gb.toFixed(1)} GB`;
}

/** Drop vendor prefixes so radio labels stay short. */
export function shortCudaGpuName(model: string): string {
  const s = (model || '').replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '').trim();
  return s || model || 'GPU';
}

export function largestCudaGpu(gpus: readonly CudaGpuDevice[]): CudaGpuDevice | null {
  if (!gpus.length) {
    return null;
  }
  return gpus.reduce((best, g) => (g.memoryTotalMb > best.memoryTotalMb ? g : best));
}

/** llama.cpp `--tensor-split` proportions from dedicated VRAM (GiB, min 1). */
export function tensorSplitForGpus(gpus: readonly CudaGpuDevice[]): string {
  if (!gpus.length) {
    return '';
  }
  return gpus.map((g) => Math.max(1, Math.round(g.memoryTotalMb / 1024))).join(',');
}

export function cudaDeviceListArg(gpus: readonly CudaGpuDevice[]): string {
  return gpus.map((g) => `CUDA${g.cudaIndex}`).join(',');
}

function estimateKvMb(ctxTokens: number): number {
  if (!Number.isFinite(ctxTokens) || ctxTokens <= 0) {
    return 4096;
  }
  return Math.min(MAX_KV_MB, Math.max(MIN_KV_MB, Math.round((ctxTokens / 1024) * KV_MB_PER_1K_CTX)));
}

function estimateNeededMb(modelBytes: number | null, ctxTokens: number): number | null {
  if (modelBytes == null || !Number.isFinite(modelBytes) || modelBytes <= 0) {
    return null;
  }
  return modelBytes / (1024 * 1024) + estimateKvMb(ctxTokens) + COMPUTE_OVERHEAD_MB;
}

/**
 * Pick fastest-card vs VRAM split. Prefer a single GPU whenever the GGUF + a
 * conservative KV/compute reserve fits, because layer-split across unequal
 * cards stalls the faster GPU on PCIe.
 */
export function recommendGpuOffload(
  gpus: readonly CudaGpuDevice[],
  modelBytes: number | null,
  ctxTokens: number,
): GpuOffloadAdvice | null {
  if (!gpus.length) {
    return null;
  }
  const ordered = [...gpus].sort((a, b) => a.cudaIndex - b.cudaIndex);
  const primary = largestCudaGpu(ordered);
  if (!primary) {
    return null;
  }
  const split = tensorSplitForGpus(ordered);
  if (ordered.length === 1) {
    return {
      mode: 'single',
      reason: `Only one CUDA GPU detected (${shortCudaGpuName(primary.model)}, ${formatGpuVramGb(primary.memoryTotalMb)}).`,
      primaryCudaIndex: primary.cudaIndex,
      tensorSplit: split,
    };
  }

  const names = ordered.map((g) => `${shortCudaGpuName(g.model)} ${formatGpuVramGb(g.memoryTotalMb)}`).join(' · ');
  const needed = estimateNeededMb(modelBytes, ctxTokens);
  const largestFit = primary.memoryTotalMb * FIT_RATIO;
  const combinedFit = ordered.reduce((s, g) => s + g.memoryTotalMb, 0) * FIT_RATIO;

  if (needed == null) {
    return {
      mode: 'single',
      reason: `Model size unknown — ${shortCudaGpuName(primary.model)} (${formatGpuVramGb(primary.memoryTotalMb)}) is the fast default. Choose Split if RAM fills and VRAM does not.`,
      primaryCudaIndex: primary.cudaIndex,
      tensorSplit: split,
    };
  }

  if (needed <= largestFit) {
    return {
      mode: 'single',
      reason: `This model fits on the ${shortCudaGpuName(primary.model)} (${formatGpuVramGb(primary.memoryTotalMb)}). Splitting onto a smaller card usually slows decode because layers wait on PCIe.`,
      primaryCudaIndex: primary.cudaIndex,
      tensorSplit: split,
    };
  }

  if (needed <= combinedFit) {
    return {
      mode: 'split',
      reason: `This model is larger than the ${shortCudaGpuName(primary.model)} (${formatGpuVramGb(primary.memoryTotalMb)}). Split by VRAM (${names}) keeps weights on the GPUs instead of system RAM.`,
      primaryCudaIndex: primary.cudaIndex,
      tensorSplit: split,
    };
  }

  return {
    mode: 'split',
    reason: `Both cards together may still be tight (${names}). Split is better than spilling to RAM; lower context if it still offloads to the CPU.`,
    primaryCudaIndex: primary.cudaIndex,
    tensorSplit: split,
  };
}

const DEV_FLAG_RE =
  /(?:^|[\s"'])(?:--device|-dev)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const DEV_FLAG_REPLACE_RE =
  /(^|[\s"'])((--device|-dev)(?:\s+|=)(?:"[^"]+"|'[^']+'|\S+))/i;
const TS_FLAG_RE =
  /(?:^|[\s"'])(?:--tensor-split|-ts)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const TS_FLAG_REPLACE_RE =
  /(^|[\s"'])((--tensor-split|-ts)(?:\s+|=)(?:"[^"]+"|'[^']+'|\S+))/i;
const MG_FLAG_RE =
  /(?:^|[\s"'])(?:--main-gpu|-mg)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const MG_FLAG_REPLACE_RE =
  /(^|[\s"'])((--main-gpu|-mg)(?:\s+|=)(?:"[^"]+"|'[^']+'|\S+))/i;

function parseCudaIndexes(raw: string): number[] {
  const out: number[] = [];
  const re = /(?:CUDA)?(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const n = Number.parseInt(m[1] ?? '', 10);
    if (Number.isFinite(n) && !out.includes(n)) {
      out.push(n);
    }
  }
  return out;
}

export interface ParsedGpuOffload {
  mode: ManagedGpuOffloadMode;
  cudaIndexes: number[];
  tensorSplit: string | null;
  mainGpu: number | null;
}

/** Read `-dev` / `--tensor-split` / `--main-gpu` from a managed chat command. */
export function parseManagedLlamaGpuOffload(cmd: string): ParsedGpuOffload {
  const t = (cmd || '').trim();
  const empty: ParsedGpuOffload = { mode: 'auto', cudaIndexes: [], tensorSplit: null, mainGpu: null };
  if (!t) {
    return empty;
  }
  const devM = DEV_FLAG_RE.exec(t);
  const tsM = TS_FLAG_RE.exec(t);
  const mgM = MG_FLAG_RE.exec(t);
  const cudaIndexes = devM ? parseCudaIndexes(unquoteShellToken(devM[1] ?? devM[2] ?? devM[3] ?? '')) : [];
  const tensorSplit = tsM ? unquoteShellToken(tsM[1] ?? tsM[2] ?? tsM[3] ?? '') : null;
  let mainGpu: number | null = null;
  if (mgM) {
    const n = Number.parseInt(unquoteShellToken(mgM[1] ?? mgM[2] ?? mgM[3] ?? ''), 10);
    mainGpu = Number.isFinite(n) ? n : null;
  }
  if (cudaIndexes.length >= 2 || (tensorSplit && tensorSplit.includes(','))) {
    return { mode: 'split', cudaIndexes, tensorSplit, mainGpu };
  }
  if (cudaIndexes.length === 1) {
    return { mode: 'single', cudaIndexes, tensorSplit, mainGpu };
  }
  return { mode: 'auto', cudaIndexes, tensorSplit, mainGpu };
}

function collapseSpaces(cmd: string): string {
  return cmd.replace(/\s+/g, ' ').trim();
}

function stripFlag(cmd: string, replaceRe: RegExp): string {
  let next = cmd;
  let prev = '';
  while (next !== prev) {
    prev = next;
    next = next.replace(replaceRe, '$1');
  }
  return collapseSpaces(next);
}

function upsertFlag(
  cmd: string,
  replaceRe: RegExp,
  flag: string,
  value: string,
  platform: ShellQuotingPlatform,
): string {
  const quoted = argvToShellCommandLine([flag, value], platform);
  const replaced = cmd.replace(replaceRe, (_full, lead: string) => `${lead}${quoted}`);
  if (replaced !== cmd) {
    return collapseSpaces(replaced);
  }
  return collapseSpaces(`${cmd} ${quoted}`);
}

/**
 * Write `-dev` / `--tensor-split` / `--main-gpu` for Auto, fastest-card, or VRAM split.
 * `auto` removes those flags so llama.cpp keeps its default (every CUDA device).
 */
export function syncGpuOffloadInManagedChatCommand(
  cmd: string,
  mode: ManagedGpuOffloadMode,
  gpus: readonly CudaGpuDevice[],
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const ordered = [...gpus].sort((a, b) => a.cudaIndex - b.cudaIndex);
  if (mode !== 'auto' && ordered.length === 0) {
    return trimmed;
  }
  let next = stripFlag(trimmed, DEV_FLAG_REPLACE_RE);
  next = stripFlag(next, TS_FLAG_REPLACE_RE);
  next = stripFlag(next, MG_FLAG_REPLACE_RE);
  if (mode === 'auto' || ordered.length === 0) {
    return next;
  }
  if (mode === 'single' || ordered.length === 1) {
    const primary = largestCudaGpu(ordered);
    if (!primary) {
      return next;
    }
    next = upsertFlag(next, DEV_FLAG_REPLACE_RE, '-dev', `CUDA${primary.cudaIndex}`, platform);
    next = upsertFlag(next, MG_FLAG_REPLACE_RE, '--main-gpu', String(primary.cudaIndex), platform);
    return next;
  }
  const split = tensorSplitForGpus(ordered);
  const primary = largestCudaGpu(ordered);
  next = upsertFlag(next, DEV_FLAG_REPLACE_RE, '-dev', cudaDeviceListArg(ordered), platform);
  if (split) {
    next = upsertFlag(next, TS_FLAG_REPLACE_RE, '--tensor-split', split, platform);
  }
  if (primary) {
    next = upsertFlag(next, MG_FLAG_REPLACE_RE, '--main-gpu', String(primary.cudaIndex), platform);
  }
  return next;
}

/** Re-apply previously parsed `-dev` / `--tensor-split` / `--main-gpu` onto a rebuilt command. */
export function syncGpuOffloadFromParsed(
  cmd: string,
  parsed: ParsedGpuOffload,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  if (parsed.mode === 'auto') {
    return collapseSpaces(
      stripFlag(stripFlag(stripFlag(trimmed, DEV_FLAG_REPLACE_RE), TS_FLAG_REPLACE_RE), MG_FLAG_REPLACE_RE),
    );
  }
  let next = stripFlag(trimmed, DEV_FLAG_REPLACE_RE);
  next = stripFlag(next, TS_FLAG_REPLACE_RE);
  next = stripFlag(next, MG_FLAG_REPLACE_RE);
  if (parsed.cudaIndexes.length) {
    next = upsertFlag(
      next,
      DEV_FLAG_REPLACE_RE,
      '-dev',
      parsed.cudaIndexes.map((i) => `CUDA${i}`).join(','),
      platform,
    );
  }
  if (parsed.mode === 'split' && parsed.tensorSplit) {
    next = upsertFlag(next, TS_FLAG_REPLACE_RE, '--tensor-split', parsed.tensorSplit, platform);
  }
  if (parsed.mainGpu != null) {
    next = upsertFlag(next, MG_FLAG_REPLACE_RE, '--main-gpu', String(parsed.mainGpu), platform);
  }
  return next;
}
