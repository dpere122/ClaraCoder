/**
 * Size a model for its GPUs, and recommend and apply llama-server GPU placement: one CUDA card vs a
 * VRAM-weighted split.
 */
import {
  CTK_FLAG_NAMES,
  CTV_FLAG_NAMES,
  CTX_FLAG_NAMES,
  detectShellQuotingPlatform,
  DRAFT_MODEL_FLAG_NAMES,
  FA_FLAG_NAMES,
  findLlamaFlag,
  hasLlamaFlag,
  isLlamaFlashAttnOff,
  llamaCommandUsesDraftMtp,
  NGL_FLAG_NAMES,
  QUANTIZED_CACHE_TYPE_RE,
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

/** What `-c 0` (model native) usually means for the large-context models Clara runs. */
const ASSUMED_NATIVE_CTX = 262_144;

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

/** KV cache size of a command's `-ctk` / `-ctv`, as a multiple of the `q8_0` size. */
export function managedLlamaKvCacheWeight(cmd: string): number {
  return (cacheTypeWeight(readLlamaFlagValue(cmd, CTK_FLAG_NAMES)) + cacheTypeWeight(readLlamaFlagValue(cmd, CTV_FLAG_NAMES))) / 2;
}

/** What a GGUF header says about a model's memory, read in main. Sizes are in bytes. */
export interface GgufProfile {
  /** Context the model was trained for; 0 when the header has none. */
  contextTrain: number;
  /** Width of the state an MTP head reads: `embedding_length_out`, else `embedding_length`. */
  embeddingOut: number;
  /** Layers past the regular ones: above 0, the file holds an MTP head. */
  nextnLayers: number;
  /** All tensor data, across shards. */
  tensorBytes: number;
  /** Tensors llama.cpp keeps in host memory. */
  hostBytes: number;
  /** Tensors of the {@link nextnLayers}, which load only under `--spec-type draft-mtp`. */
  headBytes: number;
  recurrentStateBytes: number;
  /** Over the full-attention layers that own a KV cache: `head_count_kv` times the key and value length. */
  fullKeys: number;
  fullValues: number;
  maxFullKey: number;
  /** The same over the sliding-window layers. */
  swaKeys: number;
  swaValues: number;
  slidingWindow: number;
  /** Key and value lengths: a quantized cache type needs them divisible by its block size. */
  cacheLengths: number[];
}

export interface ProfileEstimateOptions {
  c: number;
  ctk: string;
  ctv: string;
  ub: number;
  cards: number;
  /** The head layers in the file load too: `--spec-type draft-mtp` with no draft model. */
  embeddedHead: boolean;
  /** Tensor bytes of a `--spec-draft-model` head; 0 when it hasn't been read. Omit without one. */
  companionHeadBytes?: number;
}

const MIB = 1024 * 1024;
/** Bytes per element of each `-ctk` / `-ctv` type (block bytes over block elements). */
const CACHE_ELEMENT_BYTES: Readonly<Record<string, number>> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
  iq4_nl: 8 / 16,
};
/** Fitted, with the per-token `4 * maxFullKey` and `2 * ub`, on 22 measured loads: worst error 1.6%. */
const CARD_OVERHEAD_MB = 229;
const CARD_OVERHEAD_MB_PER_UBATCH = 0.11;
/** One measurement: a Gemma 12B companion head took its tensors plus this much. */
const COMPANION_HEAD_OVERHEAD_MB = 245;
const DEFAULT_UBATCH = 512;
const DEFAULT_BATCH = 2048;

/** An unknown type counts as llama.cpp's default, f16. */
function cacheElementBytes(type: string): number {
  return CACHE_ELEMENT_BYTES[type.toLowerCase()] ?? 2;
}

function pad256(n: number): number {
  return Math.ceil(n / 256) * 256;
}

/** VRAM in MiB that a model takes loaded with these settings, from its header. */
export function estimateProfileMb(p: GgufProfile, o: ProfileEstimateOptions): number {
  const k = cacheElementBytes(o.ctk);
  const v = cacheElementBytes(o.ctv);
  const quantizedKeys = QUANTIZED_CACHE_TYPE_RE.test(o.ctk) ? 4 * p.maxFullKey : 0;
  const perToken = p.fullKeys * k + p.fullValues * v + o.cards * (quantizedKeys + 2 * o.ub);
  const perSwaCell = p.swaKeys * k + p.swaValues * v;
  const swaCells = perSwaCell > 0 ? pad256(Math.min(o.c, p.slidingWindow + o.ub)) : 0;
  const weights = p.tensorBytes - p.hostBytes - (o.embeddedHead ? 0 : p.headBytes);
  const companionMb = o.companionHeadBytes === undefined ? 0 : o.companionHeadBytes / MIB + COMPANION_HEAD_OVERHEAD_MB;
  return (
    (weights + p.recurrentStateBytes + perSwaCell * swaCells + o.c * perToken) / MIB +
    companionMb +
    o.cards * (CARD_OVERHEAD_MB + CARD_OVERHEAD_MB_PER_UBATCH * o.ub)
  );
}

function positiveFlagValue(cmd: string, names: readonly string[], fallback: number): number {
  const n = Number.parseInt(readLlamaFlagValue(cmd, names) ?? '', 10);
  return n > 0 ? n : fallback;
}

function profileEstimateOptions(
  cmd: string,
  profile: GgufProfile,
  cards: number,
  companionHeadBytes: number | undefined,
): ProfileEstimateOptions {
  const mtp = llamaCommandUsesDraftMtp(cmd);
  const companion = mtp && hasLlamaFlag(cmd, DRAFT_MODEL_FLAG_NAMES);
  return {
    c: positiveFlagValue(cmd, CTX_FLAG_NAMES, profile.contextTrain || ASSUMED_NATIVE_CTX),
    ctk: readLlamaFlagValue(cmd, CTK_FLAG_NAMES) ?? 'f16',
    ctv: readLlamaFlagValue(cmd, CTV_FLAG_NAMES) ?? 'f16',
    ub: Math.min(positiveFlagValue(cmd, UBATCH_FLAG_NAMES, DEFAULT_UBATCH), positiveFlagValue(cmd, BATCH_FLAG_NAMES, DEFAULT_BATCH)),
    cards,
    embeddedHead: mtp && !companion,
    ...(companion ? { companionHeadBytes: companionHeadBytes ?? 0 } : {}),
  };
}

/** A model's header and the command loading it. With this, sizes come from the header, not a constant. */
export interface ManagedLlamaSizing {
  profile: GgufProfile;
  command: string;
  /** Tensor bytes of the command's `--spec-draft-model`, when read. */
  companionHeadBytes?: number;
}

function estimateNeededMb(
  modelBytes: number | null,
  ctxTokens: number,
  kvCacheWeight: number,
  cards: number,
  sizing?: ManagedLlamaSizing | null,
): number | null {
  if (sizing) {
    return estimateProfileMb(
      sizing.profile,
      profileEstimateOptions(sizing.command, sizing.profile, cards, sizing.companionHeadBytes),
    );
  }
  if (modelBytes == null || !Number.isFinite(modelBytes) || modelBytes <= 0) {
    return null;
  }
  const ctx = Number.isFinite(ctxTokens) && ctxTokens > 0 ? ctxTokens : ASSUMED_NATIVE_CTX;
  return modelBytes / (1024 * 1024) + (ctx / 1024) * KV_MB_PER_1K_CTX * kvCacheWeight + COMPUTE_OVERHEAD_MB;
}

/**
 * Pick fastest-card vs VRAM split. Prefer a single GPU whenever the GGUF + a
 * conservative KV/compute reserve fits, because layer-split across unequal
 * cards stalls the faster GPU on PCIe. `usage` takes what the desktop and other
 * apps already hold off each card, when it's known; `kvCacheWeight` comes from
 * {@link managedLlamaKvCacheWeight}.
 */
export function recommendGpuOffload(
  gpus: readonly CudaGpuDevice[],
  modelBytes: number | null,
  ctxTokens: number,
  usage: readonly GpuVramCardUsage[] = [],
  kvCacheWeight = 1,
  sizing?: ManagedLlamaSizing | null,
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
  const neededOnOne = estimateNeededMb(modelBytes, ctxTokens, kvCacheWeight, 1, sizing);
  const neededOnAll = estimateNeededMb(modelBytes, ctxTokens, kvCacheWeight, ordered.length, sizing);
  const availableMb = (g: CudaGpuDevice): number =>
    Math.max(0, g.memoryTotalMb - (usage.find((u) => u.cudaIndex === g.cudaIndex)?.otherMb ?? 0));
  const largestFit = availableMb(primary) * FIT_RATIO;
  const combinedFit = ordered.reduce((s, g) => s + availableMb(g), 0) * FIT_RATIO;

  if (neededOnOne == null || neededOnAll == null) {
    return {
      mode: 'single',
      reason: `Model size unknown — ${shortCudaGpuName(primary.model)} (${formatGpuVramGb(primary.memoryTotalMb)}) is the fast default. Choose Split if RAM fills and VRAM does not.`,
      primaryCudaIndex: primary.cudaIndex,
      tensorSplit: split,
    };
  }

  if (neededOnOne <= largestFit) {
    return {
      mode: 'single',
      reason: `This model fits on the ${shortCudaGpuName(primary.model)} (${formatGpuVramGb(primary.memoryTotalMb)}). Splitting onto a smaller card usually slows decode because layers wait on PCIe.`,
      primaryCudaIndex: primary.cudaIndex,
      tensorSplit: split,
    };
  }

  if (neededOnAll <= combinedFit) {
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
const SPLIT_MODE_FLAG_NAMES = ['-sm', '--split-mode'];
const BATCH_FLAG_NAMES = ['-b', '--batch-size'];
const UBATCH_FLAG_NAMES = ['-ub', '--ubatch-size'];

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

/** Under this much free, opening another app can start pushing things out of VRAM. */
const TIGHT_HEADROOM_MB = 1536;

/** `-ngl` at or past this means every layer, whatever the model has. */
const ALL_LAYERS_NGL = 99;

/**
 * Estimate each card's VRAM for a command before starting it. `null` when the model size or the
 * cards aren't known, or the command doesn't spread the whole model over CUDA cards: a partial
 * `-ngl`, `-dev none` or another backend, `-sm none`. Layers don't land exactly on the split, so
 * read the result as "about"; it runs a little high on the larger card. A `profile` sizes the model
 * from its header; without one the size comes from `modelBytes` and a constant per token. An
 * `--mmproj` file's `projectorBytes` go on the first card, where llama-server loads it.
 */
export function estimateManagedLlamaVram(
  cmd: string,
  gpus: readonly CudaGpuDevice[],
  modelBytes: number | null,
  usage: readonly GpuVramCardUsage[],
  profile?: GgufProfile | null,
  companionHeadBytes?: number,
  projectorBytes = 0,
): GpuVramCardEstimate[] | null {
  if (!gpus.length) {
    return null;
  }
  const layers = Number.parseInt(readLlamaFlagValue(cmd, NGL_FLAG_NAMES) ?? '', 10);
  if (layers >= 0 && layers < ALL_LAYERS_NGL) {
    return null;
  }
  const parsed = parseManagedLlamaGpuOffload(cmd);
  if (
    (readLlamaFlagValue(cmd, DEV_FLAG_NAMES) && !parsed.cudaIndexes.length) ||
    readLlamaFlagValue(cmd, SPLIT_MODE_FLAG_NAMES) === 'none'
  ) {
    return null;
  }
  const chosen = parsed.cudaIndexes.length ? parsed.cudaIndexes : gpus.map((g) => g.cudaIndex);
  const cards = chosen.map((i) => gpus.find((g) => g.cudaIndex === i));
  if (cards.some((g) => !g)) {
    return null;
  }
  const placed = cards as CudaGpuDevice[];
  const ctx = Number.parseInt(readLlamaFlagValue(cmd, CTX_FLAG_NAMES) ?? '', 10);
  const neededMb = estimateNeededMb(
    modelBytes,
    ctx,
    managedLlamaKvCacheWeight(cmd),
    placed.length,
    profile ? { profile, command: cmd, companionHeadBytes } : null,
  );
  if (neededMb === null) {
    return null;
  }
  const listed = (parsed.tensorSplit ?? '').split(',').map(Number);
  const weights =
    listed.length === placed.length && listed.every((w) => Number.isFinite(w) && w >= 0) && listed.some((w) => w > 0)
      ? listed
      : placed.map((g) => g.memoryTotalMb);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  return placed.map((gpu, i) => {
    const modelMb = neededMb * ((weights[i] as number) / weightSum) + (i === 0 ? projectorBytes / MIB : 0);
    const otherMb = usage.find((u) => u.cudaIndex === gpu.cudaIndex)?.otherMb ?? 0;
    const totalMb = modelMb + otherMb;
    const free = gpu.memoryTotalMb - totalMb;
    return { gpu, modelMb, otherMb, totalMb, level: free < 0 ? 'over' : free < TIGHT_HEADROOM_MB ? 'tight' : 'ok' };
  });
}

export interface ManagedLlamaTuningPlan {
  c: number;
  ctk: string;
  ctv: string;
}

const PLAN_MAX_CTX = 131_072;
export const PLAN_MIN_CTX = 16_384;
const PLAN_CTX_STEP = 4096;
/** Share of each card assumed taken when usage can't be read (the counters are localized on Windows). */
const PLAN_UNKNOWN_USAGE_SHARE = 0.15;
const Q8_BLOCK_ELEMENTS = 32;

/** False when `-ctk` / `-ctv q8_0` can't load this model: its lengths don't divide into q8 blocks. */
export function ggufProfileAllowsQuantizedCache(profile: GgufProfile): boolean {
  return profile.cacheLengths.every((length) => length % Q8_BLOCK_ELEMENTS === 0);
}

/**
 * The largest context that leaves every card `ok`, or `null` when none does or the command can't be
 * estimated. `-ctk` / `-ctv` already in the command stay. Otherwise q8 when the model and `-fa` allow
 * it: f16 may fit too, but its context checkpoints outgrow the prompt cache and stop being saved. A
 * projector counts by its file size: `ok` keeps 512 MiB more free than `--fit` asks for, which covers
 * its compute buffers, so `--fit` has no reason to move layers to the CPU.
 */
export function planManagedLlamaTuning(
  profile: GgufProfile,
  gpus: readonly CudaGpuDevice[],
  usage: readonly GpuVramCardUsage[],
  command: string,
  companionHeadBytes?: number,
  projectorBytes = 0,
): ManagedLlamaTuningPlan | null {
  const ceiling = Math.min(profile.contextTrain || PLAN_MAX_CTX, PLAN_MAX_CTX);
  const floor = Math.min(PLAN_MIN_CTX, ceiling);
  const canQuantize =
    ggufProfileAllowsQuantizedCache(profile) && !isLlamaFlashAttnOff(readLlamaFlagValue(command, FA_FLAG_NAMES));
  const setK = readLlamaFlagValue(command, CTK_FLAG_NAMES);
  const setV = readLlamaFlagValue(command, CTV_FLAG_NAMES);
  // A lone flag sets both: only matching types have a CUDA flash attention kernel, and some models
  // refuse different ones. A quantized type isn't copied where a quantized V would be fatal.
  const lone = setK ?? setV;
  const cache = lone !== null && (canQuantize || !QUANTIZED_CACHE_TYPE_RE.test(lone)) ? lone : canQuantize ? 'q8_0' : 'f16';
  const ctk = setK ?? cache;
  const ctv = setV ?? cache;
  const taken = usage.length
    ? usage
    : gpus.map((g) => ({ cudaIndex: g.cudaIndex, dedicatedMb: 0, otherMb: g.memoryTotalMb * PLAN_UNKNOWN_USAGE_SHARE }));
  for (let c = ceiling; c >= floor; c = Math.ceil(c / PLAN_CTX_STEP) * PLAN_CTX_STEP - PLAN_CTX_STEP) {
    // The last occurrence of a flag is the one that counts.
    const candidate = `${command} -c ${c} -ctk ${ctk} -ctv ${ctv}`;
    const cards = estimateManagedLlamaVram(candidate, gpus, null, taken, profile, companionHeadBytes, projectorBytes);
    if (!cards) {
      return null;
    }
    if (cards.every((card) => card.level === 'ok')) {
      return { c, ctk, ctv };
    }
  }
  return null;
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
 * Write `-dev` / `--tensor-split` / `--main-gpu` for Auto, one card, or VRAM split.
 * `auto` removes those flags so llama.cpp keeps its default (every CUDA device). `single` takes the
 * card at `cudaIndex`, else the largest, and writes no `--main-gpu`: that indexes the `-dev` list, so
 * on a later card it is out of range, which `-sm none` treats as fatal.
 */
export function syncGpuOffloadInManagedChatCommand(
  cmd: string,
  mode: ManagedGpuOffloadMode,
  gpus: readonly CudaGpuDevice[],
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
  cudaIndex?: number,
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
    const card = ordered.find((g) => g.cudaIndex === cudaIndex) ?? largestCudaGpu(ordered);
    return card ? upsertLlamaFlag(next, DEV_FLAG_NAMES, '-dev', `CUDA${card.cudaIndex}`, platform) : next;
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
