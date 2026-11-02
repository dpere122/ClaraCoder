/**
 * Pick → Optimize → Start helpers for managed llama-server:
 * infer family preset, suggest context, and generate / sync run commands.
 */
import {
  argvToShellCommandLine,
  detectShellQuotingPlatform,
  findLlamaFlag,
  hasLlamaFlag,
  lastLlamaFlag,
  readLlamaFlagValue,
  setLlamaBooleanFlag,
  spliceOutLlamaSpans,
  upsertLlamaFlag,
  type ShellQuotingPlatform,
} from './llama-command-tokens';
import { inferContextWindowTokens } from './model-context';
import type { LlmOptimizationPreset, LlmProviderConfig } from './types/app-config';
import { GEMMA_PRESET_DEFAULTS, QWEN_PRESET_DEFAULTS } from './types/llm-presets';
import type { ModelManagerFileEntry } from './types/model-manager';
import { isPinnedLlamaServerUrlProviderId } from './llm-provider-ids';

export type ManagedLlamaModelSource =
  | { kind: 'gguf'; absolutePath: string; displayName?: string; mmprojAbsolutePath?: string }
  | { kind: 'hf'; hfId: string; displayName?: string }
  | { kind: 'hubRepo'; absolutePath: string; folderName: string; displayName?: string };

export type ManagedLlamaModelFamily = 'qwen' | 'gemma' | 'other';

export type ContextFitPresetId = 'conservative' | 'balanced' | 'max';

export interface ContextFitPresetMeta {
  id: ContextFitPresetId;
  label: string;
  description: string;
}

export const CONTEXT_FIT_PRESET_LIST: readonly ContextFitPresetMeta[] = [
  {
    id: 'conservative',
    label: 'Conservative',
    description: 'Smaller context for lower VRAM / RAM use.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Mid context — good default for most machines.',
  },
  {
    id: 'max',
    label: 'Max',
    description: 'Use the full inferred context window for this model.',
  },
] as const;

/** True when the hint looks like a Qwen-family model id or filename. */
export function isQwenFamily(hint: string): boolean {
  return (hint || '').toLowerCase().includes('qwen');
}

/** Basename of a path without Node ``path`` (shared-safe). */
function fileNameFromPath(fileNameOrPath: string): string {
  return (fileNameOrPath || '').split(/[/\\]/).pop() || fileNameOrPath;
}

/**
 * True when a GGUF/GGML name is a multimodal projector (``mmproj`` in the basename).
 * Matches llama.cpp / HF GGUF convention, including Nemotron VL projectors.
 */
export function isMmprojGgufFileName(fileNameOrPath: string): boolean {
  return /mmproj/i.test(fileNameFromPath(fileNameOrPath));
}

function mmprojQualityRank(fileName: string): number {
  const n = fileName.toLowerCase();
  if (/(?:^|[^a-z0-9])f32(?:[^a-z0-9]|$)/.test(n)) {
    return 0;
  }
  if (/(?:^|[^a-z0-9])bf16(?:[^a-z0-9]|$)/.test(n)) {
    return 1;
  }
  if (/(?:^|[^a-z0-9])f16(?:[^a-z0-9]|$)/.test(n)) {
    return 2;
  }
  if (/(?:^|[^a-z0-9])q8_0(?:[^a-z0-9]|$)/.test(n)) {
    return 3;
  }
  return 4;
}

/** Prefer F16/BF16/F32 projectors when a hub folder ships several quants. */
export function pickPreferredMmprojPath(paths: readonly string[]): string | null {
  if (paths.length === 0) {
    return null;
  }
  if (paths.length === 1) {
    return paths[0] ?? null;
  }
  return [...paths].sort((a, b) => {
    const ra = mmprojQualityRank(fileNameFromPath(a));
    const rb = mmprojQualityRank(fileNameFromPath(b));
    return ra - rb || a.localeCompare(b);
  })[0] ?? null;
}

export function classifyHubSnapshotGgufPaths(paths: readonly string[]): {
  languagePaths: string[];
  mmprojPath: string | null;
} {
  const languagePaths: string[] = [];
  const mmprojPaths: string[] = [];
  for (const p of paths) {
    if (isMmprojGgufFileName(p)) {
      mmprojPaths.push(p);
    } else {
      languagePaths.push(p);
    }
  }
  return { languagePaths, mmprojPath: pickPreferredMmprojPath(mmprojPaths) };
}

/**
 * Paths Settings can pin on a hub inventory row: ``-m`` when there is exactly one
 * language GGUF, plus a detected projector even when several language quants exist.
 */
export function hubSnapshotManagedPaths(paths: readonly string[]): {
  ggufAbsolutePath?: string;
  mmprojAbsolutePath?: string;
} {
  const { languagePaths, mmprojPath } = classifyHubSnapshotGgufPaths(paths);
  return {
    ...(languagePaths.length === 1 ? { ggufAbsolutePath: languagePaths[0] } : {}),
    ...(mmprojPath ? { mmprojAbsolutePath: mmprojPath } : {}),
  };
}

function normalizeComparablePath(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function parentDirFromPath(p: string): string {
  const n = normalizeComparablePath(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '' : n.slice(0, i);
}

/**
 * Look up a hub-folder projector for a language GGUF used with ``-m``.
 * Matches the pinned snapshot file, or any GGUF sitting inside that hub folder.
 */
export function resolveMmprojPathForManagedGguf(
  ggufAbsolutePath: string,
  inventory: readonly ModelManagerFileEntry[],
): string | null {
  const path = (ggufAbsolutePath || '').trim();
  if (!path) {
    return null;
  }
  const needle = normalizeComparablePath(path);
  for (const m of inventory) {
    if (m.entryKind !== 'hubRepo') {
      continue;
    }
    const pinned = (m.mmprojAbsolutePath || '').trim();
    if (!pinned) {
      continue;
    }
    if ((m.ggufAbsolutePath || '').trim() && normalizeComparablePath(m.ggufAbsolutePath || '') === needle) {
      return pinned;
    }
    const hub = normalizeComparablePath(m.absolutePath);
    if (hub && (needle === hub || needle.startsWith(`${hub}/`))) {
      return pinned;
    }
  }
  return resolveSiblingMmprojFromInventory(path, inventory);
}

/** Strip ``.gguf`` / ``.ggml`` and common quant / mmproj tokens for name matching. */
export function languageGgufStem(fileNameOrPath: string): string {
  let s = fileNameFromPath(fileNameOrPath).replace(/\.(gguf|ggml)$/i, '');
  s = s.replace(/[-_.]?mmproj/gi, '');
  s = s.replace(
    /(?:[-_.](?:UD|imatrix))*(?:[-_.](?:Q[0-9]+(?:_[K0-9]+(?:_[A-Z]+)?)?|IQ[0-9]+\w*|F16|F32|BF16|FP16|FP32))+$/i,
    '',
  );
  return s.replace(/^[-_.]+|[-_.]+$/g, '').toLowerCase();
}

/**
 * True when an mmproj filename shares a model stem with the language GGUF.
 * Generic names like ``mmproj-BF16.gguf`` do not match (too easy to pair with the wrong model).
 */
export function mmprojNameMatchesLanguage(mmprojPath: string, languagePath: string): boolean {
  const lang = languageGgufStem(languagePath);
  const proj = languageGgufStem(mmprojPath);
  if (!lang || !proj || proj.length < 6) {
    return false;
  }
  return lang.includes(proj) || proj.includes(lang);
}

/** Loose inventory GGUF in the same directory whose name looks like a projector. */
export function resolveSiblingMmprojFromInventory(
  ggufAbsolutePath: string,
  inventory: readonly ModelManagerFileEntry[],
): string | null {
  const dir = parentDirFromPath(ggufAbsolutePath);
  if (!dir) {
    return null;
  }
  const languageInDir: string[] = [];
  const mmprojInDir: string[] = [];
  for (const m of inventory) {
    if (m.entryKind === 'hubRepo') {
      continue;
    }
    if (parentDirFromPath(m.absolutePath) !== dir) {
      continue;
    }
    if (isMmprojGgufFileName(m.fileName || m.absolutePath)) {
      mmprojInDir.push(m.absolutePath);
    } else {
      languageInDir.push(m.absolutePath);
    }
  }
  const named = mmprojInDir.filter((p) => mmprojNameMatchesLanguage(p, ggufAbsolutePath));
  if (named.length > 0) {
    return pickPreferredMmprojPath(named);
  }
  // Generic ``mmproj-F16.gguf`` only when this directory is a single-model pair,
  // not a shared dump that also contains Gemma / Qwen / Lightning GGUFs.
  if (languageInDir.length <= 1) {
    return pickPreferredMmprojPath(mmprojInDir);
  }
  return null;
}

/**
 * Projector path for the current ``-m`` / ``-hf`` selection, from hub inventory
 * or a sibling ``*mmproj*`` GGUF.
 */
export function resolveMmprojPathForManagedSelection(
  sel: { kind: 'gguf'; absolutePath: string } | { kind: 'hf'; hfId: string },
  inventory: readonly ModelManagerFileEntry[],
): string | null {
  if (sel.kind === 'gguf') {
    return resolveMmprojPathForManagedGguf(sel.absolutePath, inventory);
  }
  const hfBase = sel.hfId.split(':')[0] ?? sel.hfId;
  for (const m of inventory) {
    if (m.entryKind !== 'hubRepo') {
      continue;
    }
    const pinned = (m.mmprojAbsolutePath || '').trim();
    if (!pinned) {
      continue;
    }
    const id = hubCacheFolderToHfId(m.fileName) || hubCacheFolderToHfId(m.absolutePath);
    if (id && (id === sel.hfId || id === hfBase)) {
      return pinned;
    }
  }
  return null;
}

export function resolveMmprojPathForManagedSource(
  source: ManagedLlamaModelSource,
  inventory: readonly ModelManagerFileEntry[],
): string | null {
  if (source.kind === 'gguf') {
    const explicit = (source.mmprojAbsolutePath || '').trim();
    if (explicit) {
      return explicit;
    }
    return resolveMmprojPathForManagedSelection(
      { kind: 'gguf', absolutePath: source.absolutePath },
      inventory,
    );
  }
  if (source.kind === 'hf') {
    return resolveMmprojPathForManagedSelection({ kind: 'hf', hfId: source.hfId }, inventory);
  }
  const entry = inventory.find((m) => m.absolutePath === source.absolutePath);
  return (entry?.mmprojAbsolutePath || '').trim() || null;
}

export function inferModelFamilyFromHint(hint: string): ManagedLlamaModelFamily {
  const m = (hint || '').toLowerCase();
  if (m.includes('gemma')) {
    return 'gemma';
  }
  if (m.includes('qwen')) {
    return 'qwen';
  }
  return 'other';
}

/** Map a model id / path / filename to an optimization template. */
export function inferOptimizationPresetFromModelHint(hint: string): LlmOptimizationPreset {
  const family = inferModelFamilyFromHint(hint);
  if (family === 'gemma') {
    return 'gemma';
  }
  if (family === 'qwen') {
    return 'qwen';
  }
  return 'generic';
}

/**
 * Convert a Hugging Face hub cache folder (`models--org--repo`) to `org/repo`.
 * Accepts a bare folder name or a full path.
 */
export function hubCacheFolderToHfId(folderNameOrPath: string): string | null {
  const raw = (folderNameOrPath || '').trim();
  if (!raw) {
    return null;
  }
  const base = raw.split(/[/\\]/).pop() || raw;
  if (!/^models--/i.test(base)) {
    if (/^[^/\s]+\/[^/\s]+/.test(base)) {
      return base;
    }
    return null;
  }
  const rest = base.replace(/^models--/i, '');
  const idx = rest.indexOf('--');
  if (idx <= 0 || idx >= rest.length - 2) {
    return null;
  }
  return `${rest.slice(0, idx)}/${rest.slice(idx + 2)}`;
}

export function managedLlamaSourceHint(source: ManagedLlamaModelSource): string {
  if (source.kind === 'gguf') {
    return source.displayName || source.absolutePath.split(/[/\\]/).pop() || source.absolutePath;
  }
  if (source.kind === 'hf') {
    return source.displayName || source.hfId;
  }
  return (
    source.displayName ||
    hubCacheFolderToHfId(source.folderName) ||
    hubCacheFolderToHfId(source.absolutePath) ||
    source.folderName
  );
}

/** Suggest context tokens from model hint + Conservative / Balanced / Max fit. */
export function suggestContextWindowTokens(
  modelHint: string,
  fit: ContextFitPresetId,
  provider: 'llamacpp' | 'lmstudio' | 'openai' = 'llamacpp',
): number {
  const inferred = inferContextWindowTokens(modelHint, provider);
  if (fit === 'max') {
    return inferred;
  }
  if (fit === 'conservative') {
    return Math.min(inferred, Math.max(8_192, Math.floor(inferred * 0.25)));
  }
  return Math.min(inferred, Math.max(16_384, Math.floor(inferred * 0.5)));
}

function resolveHfIdForSource(source: ManagedLlamaModelSource): string | null {
  if (source.kind === 'hf') {
    const id = source.hfId.trim();
    return id || null;
  }
  if (source.kind === 'hubRepo') {
    return hubCacheFolderToHfId(source.folderName) || hubCacheFolderToHfId(source.absolutePath);
  }
  return null;
}

const MANAGED_CTX_FLAG_MAX = 10_000_000;

/** Clamp a ``-c`` / ``--ctx-size`` value. ``0`` means llama-server loads context from the model. */
function clampManagedContextFlag(contextWindowTokens: number): number | null {
  if (!Number.isFinite(contextWindowTokens)) {
    return null;
  }
  return Math.min(MANAGED_CTX_FLAG_MAX, Math.max(0, Math.floor(contextWindowTokens)));
}

/**
 * Parse a custom context token count from the Settings text field.
 * Rejects empty, non-integers, ``0`` (that is Max), and out-of-range values.
 */
export function parseCustomManagedContextTokens(raw: string | number): number | null {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1 || raw > MANAGED_CTX_FLAG_MAX) {
      return null;
    }
    return raw;
  }
  const t = String(raw).trim();
  if (!/^\d+$/.test(t)) {
    return null;
  }
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1 || n > MANAGED_CTX_FLAG_MAX) {
    return null;
  }
  return n;
}

/**
 * Build a managed chat ``llama-server`` command with ``{{PORT}}``, ``--jinja``,
 * ``-np 1``, ``--no-webui``, ``--cache-ram 0``, model load, and ``-c``.
 * ``contextWindowTokens`` of ``0`` emits ``-c 0`` (model-native context).
 */
export function buildManagedLlamaChatCommand(
  source: ManagedLlamaModelSource,
  contextWindowTokens: number,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const ctx = clampManagedContextFlag(contextWindowTokens);
  if (ctx === null) {
    return '';
  }
  const argv: string[] = ['llama-server', '--host', '127.0.0.1', '--port', '{{PORT}}', '--jinja'];
  if (source.kind === 'gguf') {
    const path = source.absolutePath.trim();
    if (!path) {
      return '';
    }
    argv.push('-m', path);
    const mmproj = (source.mmprojAbsolutePath || '').trim();
    if (mmproj) {
      argv.push('--mmproj', mmproj);
    }
  } else {
    const hf = resolveHfIdForSource(source);
    if (!hf) {
      return '';
    }
    argv.push('-hf', hf);
  }
  argv.push('-c', String(ctx), '--metrics', '-np', '1', '--no-webui', '--cache-ram', '0');
  return argvToShellCommandLine(argv, platform);
}

const HF_FLAG_NAMES = ['-hf', '-hfr', '--hf-repo'];
const MODEL_FLAG_NAMES = ['-m', '--model'];
const CTX_FLAG_NAMES = ['-c', '--ctx-size'];

/** Parse the selected GGUF path or HF id from an existing managed chat command. */
export function parseManagedLlamaModelSelection(
  cmd: string,
): { kind: 'gguf'; absolutePath: string } | { kind: 'hf'; hfId: string } | null {
  const t = (cmd || '').trim();
  if (!t) {
    return null;
  }
  const hfId = readLlamaFlagValue(t, HF_FLAG_NAMES);
  if (hfId) {
    return { kind: 'hf', hfId };
  }
  const absolutePath = readLlamaFlagValue(t, MODEL_FLAG_NAMES);
  return absolutePath ? { kind: 'gguf', absolutePath } : null;
}

/** Parse ``-c`` / ``--ctx-size`` from a managed chat command. ``0`` is a valid Max value. */
export function parseManagedLlamaContextSize(cmd: string): number | null {
  const raw = readLlamaFlagValue(cmd, CTX_FLAG_NAMES);
  if (raw === null || !/^-?\d+$/.test(raw)) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Replace ``-c`` / ``--ctx-size`` in a command, or append ``-c`` when missing.
 * Leaves the rest of the command intact for power-user edits. ``0`` is allowed (model max).
 */
export function syncContextFlagInManagedChatCommand(
  cmd: string,
  contextWindowTokens: number,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const ctx = clampManagedContextFlag(contextWindowTokens);
  if (ctx === null) {
    return trimmed;
  }
  return upsertLlamaFlag(trimmed, CTX_FLAG_NAMES, '-c', String(ctx), platform);
}

/** Slider / command range for ``-ngl`` (0 = CPU, 99 = llama.cpp ``auto`` / ``--fit``). */
export const MANAGED_LLAMA_NGL_MIN = 0;
export const MANAGED_LLAMA_NGL_MAX = 99;
/**
 * Display default when the chat command has no ``-ngl``.
 * llama.cpp default is ``auto`` (``--fit`` fills VRAM, shrinks context before spilling to RAM).
 */
export const MANAGED_LLAMA_NGL_DEFAULT = 99;

const NGL_FLAG_NAMES = ['-ngl', '--gpu-layers', '--n-gpu-layers'];
const NO_HOST_FLAG_NAMES = ['--no-host'];

function clampManagedNglFlag(n: number): number | null {
  if (!Number.isFinite(n)) {
    return null;
  }
  if (n < 0) {
    return MANAGED_LLAMA_NGL_DEFAULT;
  }
  return Math.min(MANAGED_LLAMA_NGL_MAX, Math.max(MANAGED_LLAMA_NGL_MIN, Math.floor(n)));
}

function parseNglToken(raw: string): number | null {
  const t = (raw || '').trim();
  if (!t) {
    return null;
  }
  if (/^auto$/i.test(t) || t === '-1') {
    return MANAGED_LLAMA_NGL_MAX;
  }
  if (/^all$/i.test(t) || t === '-2') {
    return MANAGED_LLAMA_NGL_MAX;
  }
  if (!/^-?\d+$/.test(t)) {
    return null;
  }
  const n = Number.parseInt(t, 10);
  return clampManagedNglFlag(n);
}

/** Parse ``-ngl`` / ``--n-gpu-layers`` / ``--gpu-layers``. ``auto`` / ``all`` / negatives map to 99. */
export function parseManagedLlamaNgl(cmd: string): number | null {
  const raw = readLlamaFlagValue(cmd, NGL_FLAG_NAMES);
  return raw === null ? null : parseNglToken(raw);
}

/**
 * Replace ``-ngl`` (or long aliases) in a command, or append ``-ngl`` when missing.
 * ``99`` writes ``-ngl auto`` so llama.cpp ``--fit`` can keep weights in VRAM and shrink
 * context instead of spilling layers into system RAM. ``0``–``98`` pin an exact count.
 */
export function syncNglFlagInManagedChatCommand(
  cmd: string,
  nGpuLayers: number,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const ngl = clampManagedNglFlag(nGpuLayers);
  if (ngl === null) {
    return trimmed;
  }
  const value = ngl === MANAGED_LLAMA_NGL_MAX ? 'auto' : String(ngl);
  return upsertLlamaFlag(trimmed, NGL_FLAG_NAMES, '-ngl', value, platform);
}

/**
 * Rewrite Clara's old “all layers” sentinel ``-ngl 99`` to ``-ngl auto``.
 * An explicit numeric 99 disables llama.cpp ``--fit``, which then allocates
 * model-native context (``-c 0``, often 128k–256k) and pages weights into RAM
 * while dedicated VRAM still looks free. Leaves ``999`` / ``all`` / other counts alone.
 */
export function promoteManagedSentinelNglToAuto(
  cmd: string,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  if (readLlamaFlagValue(trimmed, NGL_FLAG_NAMES) !== '99') {
    return trimmed;
  }
  return upsertLlamaFlag(trimmed, NGL_FLAG_NAMES, '-ngl', 'auto', platform);
}

/** True when the command already has the boolean ``--no-host`` token (not ``--host``). */
export function managedLlamaCommandHasNoHost(cmd: string): boolean {
  return hasLlamaFlag(cmd, NO_HOST_FLAG_NAMES);
}

/**
 * Append ``--no-host`` when enabled, or strip it when disabled.
 * Does not touch ``--host <addr>``.
 */
export function syncNoHostFlagInManagedChatCommand(cmd: string, enabled: boolean): string {
  return setLlamaBooleanFlag(cmd, NO_HOST_FLAG_NAMES, '--no-host', enabled);
}

export const MANAGED_LLAMA_FLASH_ATTN_MODES = ['auto', 'on', 'off'] as const;
export type ManagedLlamaFlashAttn = (typeof MANAGED_LLAMA_FLASH_ATTN_MODES)[number];

export const MANAGED_LLAMA_CACHE_TYPES = [
  'f32',
  'f16',
  'bf16',
  'q8_0',
  'q4_0',
  'q4_1',
  'iq4_nl',
  'q5_0',
  'q5_1',
] as const;
export type ManagedLlamaCacheType = (typeof MANAGED_LLAMA_CACHE_TYPES)[number];

/** ``0`` in the Settings field strips ``-b`` / ``-ub`` so llama.cpp keeps its defaults. */
export const MANAGED_LLAMA_BATCH_MIN = 0;
export const MANAGED_LLAMA_BATCH_MAX = 65_536;

const FA_FLAG_NAMES = ['-fa', '--flash-attn'];
const NO_MMPROJ_FLAG_NAMES = ['--no-mmproj'];
const MMPROJ_FLAG_NAMES = ['-mm', '--mmproj'];
const NO_WEBUI_FLAG_NAMES = ['--no-webui', '--no-ui'];
const PARALLEL_FLAG_NAMES = ['-np', '--parallel'];
const CACHE_RAM_FLAG_NAMES = ['-cram', '--cache-ram'];
const REASONING_FORMAT_FLAG_NAMES = ['--reasoning-format'];
const BATCH_FLAG_NAMES = ['-b', '--batch-size'];
const UBATCH_FLAG_NAMES = ['-ub', '--ubatch-size'];
const CTK_FLAG_NAMES = ['-ctk', '--cache-type-k'];
const CTV_FLAG_NAMES = ['-ctv', '--cache-type-v'];

function isFlashAttnMode(raw: string): raw is ManagedLlamaFlashAttn {
  return (MANAGED_LLAMA_FLASH_ATTN_MODES as readonly string[]).includes(raw);
}

function isCacheType(raw: string): raw is ManagedLlamaCacheType {
  return (MANAGED_LLAMA_CACHE_TYPES as readonly string[]).includes(raw);
}

function clampManagedBatchFlag(n: number): number | null {
  if (!Number.isFinite(n)) {
    return null;
  }
  const v = Math.floor(n);
  if (v < MANAGED_LLAMA_BATCH_MIN) {
    return null;
  }
  return Math.min(MANAGED_LLAMA_BATCH_MAX, v);
}

function parsePositiveOrZeroIntFlag(cmd: string, names: readonly string[]): number | null {
  const raw = readLlamaFlagValue(cmd, names);
  if (raw === null || !/^-?\d+$/.test(raw)) {
    return null;
  }
  return clampManagedBatchFlag(Number.parseInt(raw, 10));
}

/** Parse ``-fa`` / ``--flash-attn``. Bare ``-fa`` is ``on``. Missing flag is ``null`` (UI shows auto). */
export function parseManagedLlamaFlashAttn(cmd: string): ManagedLlamaFlashAttn | null {
  const occurrence = lastLlamaFlag(cmd, FA_FLAG_NAMES);
  if (!occurrence) {
    return null;
  }
  const raw = (occurrence.value ?? '').trim().toLowerCase();
  if (!raw) {
    return 'on';
  }
  return isFlashAttnMode(raw) ? raw : null;
}

/** Write ``-fa on|off|auto`` (or the existing long form). */
export function syncFlashAttnInManagedChatCommand(
  cmd: string,
  mode: ManagedLlamaFlashAttn,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  if (!isFlashAttnMode(mode)) {
    return (cmd || '').trim();
  }
  return upsertLlamaFlag(cmd, FA_FLAG_NAMES, '-fa', mode, platform);
}

export function managedLlamaCommandHasNoMmproj(cmd: string): boolean {
  return hasLlamaFlag(cmd, NO_MMPROJ_FLAG_NAMES);
}

/** Append or strip ``--no-mmproj``. */
export function syncNoMmprojFlagInManagedChatCommand(cmd: string, enabled: boolean): string {
  return setLlamaBooleanFlag(cmd, NO_MMPROJ_FLAG_NAMES, '--no-mmproj', enabled);
}

/** Parse ``--mmproj`` from a managed chat command. Absent / empty → ``null``. */
export function parseManagedLlamaMmproj(cmd: string): string | null {
  return readLlamaFlagValue(cmd, MMPROJ_FLAG_NAMES) || null;
}

/**
 * Set or strip ``--mmproj`` on a managed chat command.
 * Always removes every existing ``--mmproj`` first so llama.cpp does not see
 * the flag twice (it warns and keeps only the last value).
 */
export function syncMmprojFlagInManagedChatCommand(
  cmd: string,
  mmprojPath: string | null,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const stripped = spliceOutLlamaSpans(trimmed, findLlamaFlag(trimmed, MMPROJ_FLAG_NAMES));
  const filePath = (mmprojPath || '').trim();
  if (!filePath) {
    return stripped;
  }
  return `${stripped} ${argvToShellCommandLine(['--mmproj', filePath], platform)}`;
}

/**
 * Auto vs Off for the vision projector on a managed command.
 * Off writes ``--no-mmproj`` and strips ``--mmproj``.
 * Auto strips ``--no-mmproj`` and pins ``--mmproj`` when a hub-folder path is known.
 */
export function syncManagedVisionProjectorInChatCommand(
  cmd: string,
  opts: { noMmproj: boolean; mmprojPath: string | null },
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  if (opts.noMmproj) {
    return syncNoMmprojFlagInManagedChatCommand(syncMmprojFlagInManagedChatCommand(cmd, null, platform), true);
  }
  return syncMmprojFlagInManagedChatCommand(
    syncNoMmprojFlagInManagedChatCommand(cmd, false),
    opts.mmprojPath,
    platform,
  );
}

export function parseManagedLlamaBatchSize(cmd: string): number | null {
  return parsePositiveOrZeroIntFlag(cmd, BATCH_FLAG_NAMES);
}

export function parseManagedLlamaUbatchSize(cmd: string): number | null {
  return parsePositiveOrZeroIntFlag(cmd, UBATCH_FLAG_NAMES);
}

/**
 * Replace ``-b`` / ``--batch-size``. ``0`` strips the flag so llama.cpp uses its default (2048).
 */
export function syncBatchSizeInManagedChatCommand(
  cmd: string,
  batchSize: number,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const n = clampManagedBatchFlag(batchSize);
  if (n === null) {
    return (cmd || '').trim();
  }
  return upsertLlamaFlag(cmd, BATCH_FLAG_NAMES, '-b', n === 0 ? null : String(n), platform);
}

/**
 * Replace ``-ub`` / ``--ubatch-size``. ``0`` strips the flag so llama.cpp uses its default (512).
 */
export function syncUbatchSizeInManagedChatCommand(
  cmd: string,
  ubatchSize: number,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const n = clampManagedBatchFlag(ubatchSize);
  if (n === null) {
    return (cmd || '').trim();
  }
  return upsertLlamaFlag(cmd, UBATCH_FLAG_NAMES, '-ub', n === 0 ? null : String(n), platform);
}

export function parseManagedLlamaCacheTypeK(cmd: string): ManagedLlamaCacheType | null {
  const raw = (readLlamaFlagValue(cmd, CTK_FLAG_NAMES) ?? '').toLowerCase();
  return isCacheType(raw) ? raw : null;
}

export function parseManagedLlamaCacheTypeV(cmd: string): ManagedLlamaCacheType | null {
  const raw = (readLlamaFlagValue(cmd, CTV_FLAG_NAMES) ?? '').toLowerCase();
  return isCacheType(raw) ? raw : null;
}

/** Write ``-ctk`` / ``--cache-type-k``. ``null`` strips the flag (llama.cpp default f16). */
export function syncCacheTypeKInManagedChatCommand(
  cmd: string,
  cacheType: ManagedLlamaCacheType | null,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  if (cacheType !== null && !isCacheType(cacheType)) {
    return (cmd || '').trim();
  }
  return upsertLlamaFlag(cmd, CTK_FLAG_NAMES, '-ctk', cacheType, platform);
}

/** Write ``-ctv`` / ``--cache-type-v``. ``null`` strips the flag (llama.cpp default f16). */
export function syncCacheTypeVInManagedChatCommand(
  cmd: string,
  cacheType: ManagedLlamaCacheType | null,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  if (cacheType !== null && !isCacheType(cacheType)) {
    return (cmd || '').trim();
  }
  return upsertLlamaFlag(cmd, CTV_FLAG_NAMES, '-ctv', cacheType, platform);
}

export function managedLlamaCommandHasNoWebui(cmd: string): boolean {
  return hasLlamaFlag(cmd, NO_WEBUI_FLAG_NAMES);
}

export function managedLlamaCommandHasParallel(cmd: string): boolean {
  return hasLlamaFlag(cmd, PARALLEL_FLAG_NAMES);
}

export function managedLlamaCommandHasReasoningFormat(cmd: string): boolean {
  return hasLlamaFlag(cmd, REASONING_FORMAT_FLAG_NAMES);
}

/** True when the command already sets ``--cache-ram`` / ``-cram`` (any value). */
export function managedLlamaCommandHasCacheRam(cmd: string): boolean {
  return hasLlamaFlag(cmd, CACHE_RAM_FLAG_NAMES);
}

/**
 * Gemma 4 thought lives in ``<|channel>thought`` tags. llama-server's default
 * ``--reasoning-format deepseek`` often buffers that entire block (or parks it in
 * ``reasoning_content``, which the OpenAI Python SDK drops), so the UI shows no
 * reasoning while tokens are still being generated. ``none`` leaves tags in
 * ``content`` so Clara can split them live. Does not override a user-set flag.
 */
export function ensureManagedLlamaGemmaReasoningFormat(cmd: string): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed || managedLlamaCommandHasReasoningFormat(trimmed)) {
    return cmd;
  }
  return `${trimmed} --reasoning-format none`;
}

/**
 * Ensure managed chat commands always carry ``--no-webui``, ``-np 1`` and
 * ``--cache-ram 0`` when those flags are missing. Does not overwrite an existing
 * ``-np`` / ``--parallel`` or ``--cache-ram`` / ``-cram`` value.
 *
 * ``--cache-ram 0`` disables llama-server's host-RAM prompt cache (default 8 GiB).
 * With one slot, every prompt-prefix change (Clara's system prompt embeds the live
 * workspace tree) copies the slot's KV / recurrent state into that cache, so RAM
 * climbs by GBs over a long agent session at large context and looks like a leak.
 * The slot itself still reuses the common prefix between turns without it.
 */
export function ensureManagedLlamaDefaultServerFlags(cmd: string): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return cmd;
  }
  let out = trimmed;
  if (!managedLlamaCommandHasNoWebui(out)) {
    out = `${out} --no-webui`;
  }
  if (!managedLlamaCommandHasParallel(out)) {
    out = `${out} -np 1`;
  }
  if (!managedLlamaCommandHasCacheRam(out)) {
    out = `${out} --cache-ram 0`;
  }
  return out;
}

/** One-line Ready defaults summary for the Models UI. */
export function formatReadyDefaultsSummary(opts: {
  preset: LlmOptimizationPreset;
  contextWindowTokens: number;
  /** When true, llama-server uses ``-c 0`` (model-native); do not show a guessed k count. */
  contextMax?: boolean;
}): string {
  const ctxLabel = opts.contextMax
    ? 'max'
    : opts.contextWindowTokens >= 1000
      ? `${Math.round(opts.contextWindowTokens / 1024)}k`
      : String(opts.contextWindowTokens);
  if (opts.preset === 'qwen') {
    return `Qwen · ctx ${ctxLabel} · temp ${QWEN_PRESET_DEFAULTS.temperature}`;
  }
  if (opts.preset === 'gemma') {
    return `Gemma · ctx ${ctxLabel} · temp ${GEMMA_PRESET_DEFAULTS.temperature}`;
  }
  return `Generic · ctx ${ctxLabel}`;
}

/**
 * Partial profile fields applied when an optimization template is chosen.
 * Clears cross-preset sampling/thinking leftovers so Qwen ↔ Gemma ↔ Generic
 * switches do not keep stale inference knobs.
 */
export function optimizationPresetDefaultsPatch(preset: LlmOptimizationPreset): Record<string, unknown> {
  if (preset === 'qwen') {
    return {
      optimizationPreset: 'qwen',
      parallelToolCalls: QWEN_PRESET_DEFAULTS.parallelToolCalls,
      maxOutputTokens: QWEN_PRESET_DEFAULTS.maxOutputTokens,
      temperature: QWEN_PRESET_DEFAULTS.temperature,
      samplingPreset: 'provider-default',
      thinkingMode: 'default',
      topP: QWEN_PRESET_DEFAULTS.topP,
      topK: QWEN_PRESET_DEFAULTS.topK,
      repeatPenalty: QWEN_PRESET_DEFAULTS.repeatPenalty,
    };
  }
  if (preset === 'gemma') {
    const g = GEMMA_PRESET_DEFAULTS;
    return {
      optimizationPreset: 'gemma',
      parallelToolCalls: g.parallelToolCalls,
      maxOutputTokens: g.maxOutputTokens,
      temperature: g.temperature,
      samplingPreset: g.samplingPreset,
      thinkingMode: g.thinkingMode,
      architectureHint: g.architectureHint,
      topP: g.topP,
      topK: g.topK,
      repeatPenalty: undefined,
    };
  }
  return {
    optimizationPreset: 'generic',
    samplingPreset: 'provider-default',
    thinkingMode: 'default',
    topP: undefined,
    topK: undefined,
    repeatPenalty: undefined,
  };
}

/**
 * Compute the managed-model picker value (``gguf:…`` / ``hub:…`` / ``hf:…`` / empty)
 * for an arbitrary chat command, resolved against the local model inventory so a
 * ``-hf`` selection that matches a hub cache folder is reported as ``hub:…``.
 */
export function managedPickerValueForCmd(cmd: string, inventory: ModelManagerFileEntry[]): string {
  const sel = parseManagedLlamaModelSelection(cmd);
  if (!sel) {
    return '';
  }
  if (sel.kind === 'gguf') {
    const hubWithFile = inventory.find(
      (m) => m.entryKind === 'hubRepo' && !!m.ggufAbsolutePath && m.ggufAbsolutePath === sel.absolutePath,
    );
    if (hubWithFile) {
      return `hub:${hubWithFile.absolutePath}`;
    }
    return `gguf:${sel.absolutePath}`;
  }
  const hfBase = sel.hfId.split(':')[0] ?? sel.hfId;
  for (const m of inventory) {
    if (m.entryKind === 'hubRepo') {
      const id = hubCacheFolderToHfId(m.fileName) || hubCacheFolderToHfId(m.absolutePath);
      if (id && (id === sel.hfId || id === hfBase)) {
        return `hub:${m.absolutePath}`;
      }
    }
  }
  return `hf:${sel.hfId}`;
}

/**
 * Display name for a managed llama-server source row: the user-set ``customName``
 * when present, else mirroring the Local model dropdown: the inventory file name
 * for a GGUF/hub pick, or the HF id for an HF pick, falling back to the stored
 * provider name when no model is selected.
 * Non-managed (non-llamacpp or URL-only llama) providers return their stored name.
 * The ``.gguf`` / ``.ggml`` extension is trimmed from loose GGUF file names so the
 * Models list shows a clean model label instead of a raw filename.
 */
export function managedLlamaSourceDisplayName(
  provider: LlmProviderConfig,
  inventory: ModelManagerFileEntry[],
): string {
  if (provider.provider !== 'llamacpp' || isPinnedLlamaServerUrlProviderId(provider.id)) {
    return provider.name;
  }
  const custom = (provider.customName ?? '').trim();
  if (custom) {
    return custom;
  }
  return managedLlamaModelLabel(provider, inventory);
}

/**
 * Label a managed llama-server source gets from its selected model, ignoring any
 * ``customName``; the placeholder of the source Name field.
 */
export function managedLlamaModelLabel(provider: LlmProviderConfig, inventory: ModelManagerFileEntry[]): string {
  const cmd = provider.models[0]?.llamaCppManaged?.chatRunCommand ?? '';
  const picker = managedPickerValueForCmd(cmd, inventory);
  if (!picker) {
    return provider.name;
  }
  if (picker.startsWith('hf:')) {
    return picker.slice('hf:'.length) || provider.name;
  }
  const match = inventory.find(
    (m) => (m.entryKind === 'hubRepo' ? `hub:${m.absolutePath}` : `gguf:${m.absolutePath}`) === picker,
  );
  if (!match) {
    return provider.name;
  }
  if (match.entryKind === 'hubRepo') {
    return match.fileName;
  }
  return stripModelExtensionForDisplay(match.fileName) || provider.name;
}

/** Remove a trailing ``.gguf`` / ``.ggml`` (case-insensitive) for display purposes. */
function stripModelExtensionForDisplay(fileName: string): string {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.gguf')) {
    return fileName.slice(0, -'.gguf'.length);
  }
  if (lower.endsWith('.ggml')) {
    return fileName.slice(0, -'.ggml'.length);
  }
  return fileName || '';
}
