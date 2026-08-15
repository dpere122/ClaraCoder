/**
 * Pick → Optimize → Start helpers for managed llama-server:
 * infer family preset, suggest context, and generate / sync run commands.
 */
import {
  argvToShellCommandLine,
  detectShellQuotingPlatform,
  type ShellQuotingPlatform,
} from './llama-cpp-managed';
import { inferContextWindowTokens } from './model-context';
import type { LlmOptimizationPreset, LlmProviderConfig } from './types/app-config';
import { GEMMA_PRESET_DEFAULTS, QWEN_PRESET_DEFAULTS } from './types/llm-presets';
import type { ModelManagerFileEntry } from './types/model-manager';
import { isPinnedLlamaServerUrlProviderId } from './llm-provider-ids';

export type ManagedLlamaModelSource =
  | { kind: 'gguf'; absolutePath: string; displayName?: string }
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
 * Build a managed chat ``llama-server`` command with ``{{PORT}}``, model load, and ``-c``.
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
  const argv: string[] = ['llama-server', '--host', '127.0.0.1', '--port', '{{PORT}}'];
  if (source.kind === 'gguf') {
    const path = source.absolutePath.trim();
    if (!path) {
      return '';
    }
    argv.push('-m', path);
  } else {
    const hf = resolveHfIdForSource(source);
    if (!hf) {
      return '';
    }
    argv.push('-hf', hf);
  }
  argv.push('-c', String(ctx), '--metrics');
  return argvToShellCommandLine(argv, platform);
}

function unquoteShellToken(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse the selected GGUF path or HF id from an existing managed chat command. */
export function parseManagedLlamaModelSelection(
  cmd: string,
): { kind: 'gguf'; absolutePath: string } | { kind: 'hf'; hfId: string } | null {
  const t = (cmd || '').trim();
  if (!t) {
    return null;
  }
  const hf = /\s-hf(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(t);
  if (hf) {
    const id = unquoteShellToken(hf[1] ?? hf[2] ?? hf[3] ?? '');
    return id ? { kind: 'hf', hfId: id } : null;
  }
  const m = /\s-m(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(t);
  if (m) {
    const path = unquoteShellToken(m[1] ?? m[2] ?? m[3] ?? '');
    return path ? { kind: 'gguf', absolutePath: path } : null;
  }
  return null;
}

/** Parse ``-c`` / ``--ctx-size`` from a managed chat command. ``0`` is a valid Max value. */
export function parseManagedLlamaContextSize(cmd: string): number | null {
  const t = (cmd || '').trim();
  if (!t) {
    return null;
  }
  const m = /(?:^|[\s"'])(?:--ctx-size|-c)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(t);
  if (!m) {
    return null;
  }
  const raw = unquoteShellToken(m[1] ?? m[2] ?? m[3] ?? '');
  if (!/^-?\d+$/.test(raw)) {
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
  const ctxStr = String(ctx);
  const replaced = trimmed.replace(
    /(^|[\s"'])((--ctx-size|-c)(?:\s+|=)(?:"[^"]+"|'[^']+'|\S+))/i,
    (_full, lead: string, _flagged: string, flag: string) => `${lead}${flag} ${ctxStr}`,
  );
  if (replaced !== trimmed) {
    return replaced;
  }
  return `${trimmed} ${argvToShellCommandLine(['-c', ctxStr], platform)}`;
}

/** Slider / command range for ``-ngl`` (0 = CPU, 99 = llama.cpp ``auto`` / ``--fit``). */
export const MANAGED_LLAMA_NGL_MIN = 0;
export const MANAGED_LLAMA_NGL_MAX = 99;
/**
 * Display default when the chat command has no ``-ngl``.
 * llama.cpp default is ``auto`` (``--fit`` fills VRAM, shrinks context before spilling to RAM).
 */
export const MANAGED_LLAMA_NGL_DEFAULT = 99;

const NGL_FLAG_RE =
  /(?:^|[\s"'])(?:--n-gpu-layers|--gpu-layers|-ngl)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const NGL_FLAG_REPLACE_RE =
  /(^|[\s"'])((--n-gpu-layers|--gpu-layers|-ngl)(?:\s+|=)(?:"[^"]+"|'[^']+'|\S+))/i;
const NO_HOST_TOKEN_RE = /(?:^|[\s"'])--no-host(?:\s|=|$)/i;

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
  const t = (cmd || '').trim();
  if (!t) {
    return null;
  }
  const m = NGL_FLAG_RE.exec(t);
  if (!m) {
    return null;
  }
  return parseNglToken(unquoteShellToken(m[1] ?? m[2] ?? m[3] ?? ''));
}

function replaceNglFlagValue(
  cmd: string,
  value: string,
  platform: ShellQuotingPlatform,
): string {
  const replaced = cmd.replace(
    NGL_FLAG_REPLACE_RE,
    (_full, lead: string, _flagged: string, flag: string) => `${lead}${flag} ${value}`,
  );
  if (replaced !== cmd) {
    return replaced;
  }
  return `${cmd} ${argvToShellCommandLine(['-ngl', value], platform)}`;
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
  if (ngl === MANAGED_LLAMA_NGL_MAX) {
    return replaceNglFlagValue(trimmed, 'auto', platform);
  }
  return replaceNglFlagValue(trimmed, String(ngl), platform);
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
  const m = NGL_FLAG_RE.exec(trimmed);
  if (!m) {
    return trimmed;
  }
  const raw = unquoteShellToken(m[1] ?? m[2] ?? m[3] ?? '');
  if (raw !== '99') {
    return trimmed;
  }
  return replaceNglFlagValue(trimmed, 'auto', platform);
}

/** True when the command already has the boolean ``--no-host`` token (not ``--host``). */
export function managedLlamaCommandHasNoHost(cmd: string): boolean {
  return NO_HOST_TOKEN_RE.test((cmd || '').trim());
}

/**
 * Append ``--no-host`` when enabled, or strip it when disabled.
 * Does not touch ``--host <addr>``.
 */
export function syncNoHostFlagInManagedChatCommand(cmd: string, enabled: boolean): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const has = managedLlamaCommandHasNoHost(trimmed);
  if (enabled) {
    if (has) {
      return trimmed;
    }
    return `${trimmed} --no-host`;
  }
  if (!has) {
    return trimmed;
  }
  return trimmed
    .replace(/(^|[\s"'])--no-host(?=\s|$)/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
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
 * Display name for a managed llama-server source row, mirroring the Local model
 * dropdown: the inventory file name for a GGUF/hub pick, or the HF id for an HF
 * pick, falling back to the stored provider name when no model is selected.
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
