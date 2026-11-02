/**
 * Recommend and apply llama-server GPU placement: one CUDA card vs a VRAM-weighted split.
 */
import {
  detectShellQuotingPlatform,
  findLlamaFlag,
  readLlamaFlagValue,
  spliceOutLlamaSpans,
  upsertLlamaFlag,
  type ShellQuotingPlatform,
} from './llama-command-tokens';

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
/**
 * KV cache for a 27B-class model with `-ctk q8_0 -ctv q8_0`. From measurements on Qwen3.8-27B
 * Q6: halving `-c` from 262144 freed about 5.5 GB across two cards.
 */
const KV_MB_PER_1K_CTX = 42;


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
    // ``-c 0`` is model-native context (Gemma 4 12B is 256k). Use the KV cap so
    // Fastest-card vs Split does not treat Max as a tiny cache.
    return MAX_KV_MB;
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
 * cards stalls the faster GPU on PCIe. `usage` takes what the desktop and other
 * apps already hold off each card, when it's known.
 */
export function recommendGpuOffload(
  gpus: readonly CudaGpuDevice[],
  modelBytes: number | null,
  ctxTokens: number,
  usage: readonly GpuVramCardUsage[] = [],
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
  const availableMb = (g: CudaGpuDevice): number =>
    Math.max(0, g.memoryTotalMb - (usage.find((u) => u.cudaIndex === g.cudaIndex)?.otherMb ?? 0));
  const largestFit = availableMb(primary) * FIT_RATIO;
  const combinedFit = ordered.reduce((s, g) => s + availableMb(g), 0) * FIT_RATIO;

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
      reason: `This model is larger than what the ${shortCudaGpuName(primary.model)} (${formatGpuVramGb(primary.memoryTotalMb)}) has free. Split by VRAM (${names}) keeps weights on the GPUs instead of system RAM.`,
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

const DEV_FLAG_NAMES = ['-dev', '--device'];
const TS_FLAG_NAMES = ['-ts', '--tensor-split'];
const MG_FLAG_NAMES = ['-mg', '--main-gpu'];

function parseCudaIndexes(raw: string): number[] {
  const out: number[] = [];
  // Require the literal `CUDA` prefix so non-CUDA device tokens (`Vulkan0`, `RPC0`,
  // `-1`, `foo123`) are not silently promoted to CUDA indexes.
  const re = /CUDA(\d+)/gi;
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
  const dev = readLlamaFlagValue(t, DEV_FLAG_NAMES);
  const tensorSplit = readLlamaFlagValue(t, TS_FLAG_NAMES);
  const mg = readLlamaFlagValue(t, MG_FLAG_NAMES);
  const cudaIndexes = dev ? parseCudaIndexes(dev) : [];
  let mainGpu: number | null = null;
  if (mg !== null) {
    const n = Number.parseInt(mg, 10);
    mainGpu = Number.isFinite(n) ? n : null;
  }
  // Split mode requires multiple devices. A lone `--tensor-split a,b` left over after
  // pinning one card must not flip the UI to Split (it would keep stale ratios).
  if (cudaIndexes.length >= 2) {
    return { mode: 'split', cudaIndexes, tensorSplit, mainGpu };
  }
  if (cudaIndexes.length === 1) {
    return { mode: 'single', cudaIndexes, tensorSplit, mainGpu };
  }
  return { mode: 'auto', cudaIndexes, tensorSplit, mainGpu };
}

function stripFlag(cmd: string, names: readonly string[]): string {
  return spliceOutLlamaSpans(cmd, findLlamaFlag(cmd, names));
}

/** VRAM allocated on one card right now, counting every process. */
export interface GpuVramCardUsage {
  cudaIndex: number;
  dedicatedMb: number;
  /** Everything except `llama-server`: the desktop and other apps. */
  otherMb: number;
}

export type GpuVramLevel = 'ok' | 'tight' | 'over';

export interface GpuVramCardEstimate {
  gpu: CudaGpuDevice;
  /** Weights, KV cache and compute buffers placed on this card. */
  modelMb: number;
  otherMb: number;
  totalMb: number;
  level: GpuVramLevel;
}

/** What `-c 0` (model native) usually means for the large-context models Clara runs. */
const ASSUMED_NATIVE_CTX = 262_144;
/** Under this much free, opening another app can start pushing things out of VRAM. */
const TIGHT_HEADROOM_MB = 1536;

/** Size of one cache cell against `q8_0`. Without `-ctk` / `-ctv`, llama.cpp uses f16. */
function cacheTypeWeight(type: string | null): number {
  const t = (type ?? 'f16').toLowerCase();
  if (t === 'f32') {
    return 4;
  }
  if (t === 'f16' || t === 'bf16') {
    return 2;
  }
  return t.startsWith('q8') ? 1 : t.startsWith('q5') ? 0.625 : t.startsWith('q4') || t.startsWith('iq4') ? 0.5 : 2;
}

/**
 * Estimate each card's VRAM for a command before starting it. `null` when the model size or the
 * cards aren't known, or the model stays off the GPU (`-ngl 0`). Layers don't land exactly on the
 * split, so read the result as "about"; it runs a little high on the larger card.
 */
export function estimateManagedLlamaVram(
  cmd: string,
  gpus: readonly CudaGpuDevice[],
  modelBytes: number | null,
  usage: readonly GpuVramCardUsage[],
): GpuVramCardEstimate[] | null {
  if (modelBytes == null || !Number.isFinite(modelBytes) || modelBytes <= 0 || !gpus.length) {
    return null;
  }
  if (readLlamaFlagValue(cmd, ['-ngl', '--gpu-layers', '--n-gpu-layers']) === '0') {
    return null;
  }
  const parsed = parseManagedLlamaGpuOffload(cmd);
  const chosen = parsed.cudaIndexes.length ? parsed.cudaIndexes : gpus.map((g) => g.cudaIndex);
  const cards = chosen.map((i) => gpus.find((g) => g.cudaIndex === i));
  if (cards.some((g) => !g)) {
    return null;
  }
  const placed = cards as CudaGpuDevice[];
  const listed = (parsed.tensorSplit ?? '').split(',').map(Number);
  const weights =
    listed.length === placed.length && listed.every((w) => Number.isFinite(w) && w >= 0) && listed.some((w) => w > 0)
      ? listed
      : placed.map((g) => g.memoryTotalMb);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const ctx = Number.parseInt(readLlamaFlagValue(cmd, ['-c', '--ctx-size']) ?? '', 10);
  const cacheWeight =
    (cacheTypeWeight(readLlamaFlagValue(cmd, ['-ctk', '--cache-type-k'])) +
      cacheTypeWeight(readLlamaFlagValue(cmd, ['-ctv', '--cache-type-v']))) /
    2;
  const kvMb = ((ctx > 0 ? ctx : ASSUMED_NATIVE_CTX) / 1024) * KV_MB_PER_1K_CTX * cacheWeight;
  const neededMb = modelBytes / (1024 * 1024) + kvMb + COMPUTE_OVERHEAD_MB;
  return placed.map((gpu, i) => {
    const modelMb = neededMb * ((weights[i] as number) / weightSum);
    const otherMb = usage.find((u) => u.cudaIndex === gpu.cudaIndex)?.otherMb ?? 0;
    const totalMb = modelMb + otherMb;
    const free = gpu.memoryTotalMb - totalMb;
    return { gpu, modelMb, otherMb, totalMb, level: free < 0 ? 'over' : free < TIGHT_HEADROOM_MB ? 'tight' : 'ok' };
  });
}

/** Cards with more allocated right now than they physically have. */
export function overcommittedCards(
  gpus: readonly CudaGpuDevice[],
  usage: readonly GpuVramCardUsage[],
): { gpu: CudaGpuDevice; dedicatedMb: number }[] {
  return usage.flatMap((u) => {
    const gpu = gpus.find((g) => g.cudaIndex === u.cudaIndex);
    return gpu && u.dedicatedMb > gpu.memoryTotalMb ? [{ gpu, dedicatedMb: u.dedicatedMb }] : [];
  });
}

/** A two-card `--tensor-split`, as whole GB on the first card out of both cards' VRAM. */
export interface TensorSplitSlider {
  first: CudaGpuDevice;
  second: CudaGpuDevice;
  /** Both cards' VRAM in GB: the two sides always add up to this. */
  total: number;
  value: number;
}

/**
 * Slider state for a command split across exactly two known cards. Any ratio `--tensor-split`
 * accepts maps onto it (`3,1` reads as 3/4 of the total). `null` when a slider can't express the
 * split: another device count, or a list that isn't two positive weights.
 */
export function tensorSplitSliderForCommand(cmd: string, gpus: readonly CudaGpuDevice[]): TensorSplitSlider | null {
  const parsed = parseManagedLlamaGpuOffload(cmd);
  if (parsed.mode !== 'split' || parsed.cudaIndexes.length !== 2) {
    return null;
  }
  const first = gpus.find((g) => g.cudaIndex === parsed.cudaIndexes[0]);
  const second = gpus.find((g) => g.cudaIndex === parsed.cudaIndexes[1]);
  if (!first || !second) {
    return null;
  }
  const vramGb = (g: CudaGpuDevice): number => Math.max(1, Math.round(g.memoryTotalMb / 1024));
  const total = vramGb(first) + vramGb(second);
  let share = vramGb(first) / total;
  if (parsed.tensorSplit !== null) {
    const weights = parsed.tensorSplit.split(',').map(Number);
    const [a, b] = weights;
    if (weights.length !== 2 || !a || !b || a < 0 || b < 0) {
      return null;
    }
    share = a / (a + b);
  }
  return { first, second, total, value: Math.min(total - 1, Math.max(1, Math.round(share * total))) };
}

/** Write a two-card `--tensor-split` from a slider position. */
export function syncTensorSplitSliderInManagedChatCommand(
  cmd: string,
  firstGb: number,
  total: number,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const first = Math.min(total - 1, Math.max(1, Math.round(firstGb)));
  return upsertLlamaFlag(cmd, TS_FLAG_NAMES, '--tensor-split', `${first},${total - first}`, platform);
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
  let next = stripFlag(trimmed, DEV_FLAG_NAMES);
  next = stripFlag(next, TS_FLAG_NAMES);
  next = stripFlag(next, MG_FLAG_NAMES);
  if (mode === 'auto' || ordered.length === 0) {
    return next;
  }
  if (mode === 'single' || ordered.length === 1) {
    const primary = largestCudaGpu(ordered);
    if (!primary) {
      return next;
    }
    next = upsertLlamaFlag(next, DEV_FLAG_NAMES, '-dev', `CUDA${primary.cudaIndex}`, platform);
    next = upsertLlamaFlag(next, MG_FLAG_NAMES, '--main-gpu', String(primary.cudaIndex), platform);
    return next;
  }
  const split = tensorSplitForGpus(ordered);
  const primary = largestCudaGpu(ordered);
  next = upsertLlamaFlag(next, DEV_FLAG_NAMES, '-dev', cudaDeviceListArg(ordered), platform);
  if (split) {
    next = upsertLlamaFlag(next, TS_FLAG_NAMES, '--tensor-split', split, platform);
  }
  if (primary) {
    next = upsertLlamaFlag(next, MG_FLAG_NAMES, '--main-gpu', String(primary.cudaIndex), platform);
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
    return stripFlag(stripFlag(stripFlag(trimmed, DEV_FLAG_NAMES), TS_FLAG_NAMES), MG_FLAG_NAMES);
  }
  let next = stripFlag(trimmed, DEV_FLAG_NAMES);
  next = stripFlag(next, TS_FLAG_NAMES);
  next = stripFlag(next, MG_FLAG_NAMES);
  if (parsed.cudaIndexes.length) {
    next = upsertLlamaFlag(
      next,
      DEV_FLAG_NAMES,
      '-dev',
      parsed.cudaIndexes.map((i) => `CUDA${i}`).join(','),
      platform,
    );
  }
  if (parsed.mode === 'split' && parsed.tensorSplit) {
    next = upsertLlamaFlag(next, TS_FLAG_NAMES, '--tensor-split', parsed.tensorSplit, platform);
  }
  if (parsed.mainGpu != null) {
    next = upsertLlamaFlag(next, MG_FLAG_NAMES, '--main-gpu', String(parsed.mainGpu), platform);
  }
  return next;
}
