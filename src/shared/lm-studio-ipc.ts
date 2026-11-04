import type { ChatTemplateReasoningCaps } from './chat-template-reasoning';

/** How a running instance was loaded, from ``loaded_instances[].config``. v1 only. */
export interface LmStudioRunningConfig {
  contextLength: number;
  parallel?: number;
  evalBatchSize?: number;
  flashAttention?: boolean;
  offloadKvCacheToGpu?: boolean;
}

/** Normalized row for Settings UI (v0 and v1 LM Studio REST). */
export interface LmStudioModelCard {
  id: string;
  type: string;
  publisher: string;
  arch: string;
  compatibility_type: string;
  quantization: string;
  state: string;
  /** Architectural GGUF / model max (not necessarily what is loaded). */
  max_context_length: number;
  /**
   * Context the running instance actually serves (v0 ``loaded_context_length`` or v1
   * ``loaded_instances[].config.context_length``). ``0`` when unloaded / unknown.
   */
  loaded_context_length: number;
  /** Present when loaded; use for POST /api/v1/models/unload. */
  instanceId?: string;
  /** Human name; ids can be opaque snapshot hashes. v1 only. */
  displayName?: string;
  /** Size on disk. v1 only. */
  sizeBytes?: number;
  /** Trained for tool use, which an agent needs to work well. Unset when the server doesn't say. */
  toolUse?: boolean;
  vision?: boolean;
  /** ``capabilities.reasoning.allowed_options``: some of off, on, low, medium, high. v1 only. */
  reasoningOptions?: string[];
  reasoningDefault?: string;
  runningConfig?: LmStudioRunningConfig;
}

export type LmStudioListModelsResult =
  | { ok: true; origin: string; source: 'v1' | 'v0'; models: LmStudioModelCard[] }
  | { ok: false; error: string };

export type LmStudioMutationResult = { ok: true } | { ok: false; error: string };

/** Fields sent to ``POST /api/v1/models/load``. Unset ones are left to LM Studio. */
export interface LmStudioLoadOptions {
  contextLength?: number;
  parallel?: number;
  evalBatchSize?: number;
  flashAttention?: boolean;
  offloadKvCacheToGpu?: boolean;
}

/** Saved per model profile: how Clara loads the model, and what happens when one isn't loaded. */
export interface LmStudioSettings {
  contextLength: number;
  parallel: number;
  evalBatchSize: number;
  flashAttention: boolean;
  offloadKvCacheToGpu: boolean;
  /** Load with these settings before a message goes out; else LM Studio auto-loads with its own. */
  autoLoad: boolean;
  /** Idle unload, in seconds. LM Studio only honours it on models it auto-loaded itself. */
  idleTtlSeconds: number;
}

export const DEFAULT_LM_STUDIO_SETTINGS: Readonly<LmStudioSettings> = {
  contextLength: 32768,
  parallel: 4,
  evalBatchSize: 2048,
  flashAttention: true,
  offloadKvCacheToGpu: true,
  autoLoad: true,
  idleTtlSeconds: 3600,
};

function positiveInt(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : fallback;
}

export function normalizeLmStudioSettings(raw: unknown): LmStudioSettings {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_LM_STUDIO_SETTINGS;
  return {
    contextLength: positiveInt(r['contextLength'], d.contextLength, 10_000_000),
    parallel: positiveInt(r['parallel'], d.parallel, 64),
    evalBatchSize: positiveInt(r['evalBatchSize'], d.evalBatchSize, 65536),
    flashAttention: typeof r['flashAttention'] === 'boolean' ? r['flashAttention'] : d.flashAttention,
    offloadKvCacheToGpu: typeof r['offloadKvCacheToGpu'] === 'boolean' ? r['offloadKvCacheToGpu'] : d.offloadKvCacheToGpu,
    autoLoad: typeof r['autoLoad'] === 'boolean' ? r['autoLoad'] : d.autoLoad,
    idleTtlSeconds: positiveInt(r['idleTtlSeconds'], d.idleTtlSeconds, 2_592_000),
  };
}

/** The load request for these settings; a context above the model's max is cut down to it. */
export function lmStudioLoadOptions(settings: LmStudioSettings, maxContext: number): Required<LmStudioLoadOptions> {
  return {
    contextLength: maxContext > 0 ? Math.min(settings.contextLength, maxContext) : settings.contextLength,
    parallel: settings.parallel,
    evalBatchSize: settings.evalBatchSize,
    flashAttention: settings.flashAttention,
    offloadKvCacheToGpu: settings.offloadKvCacheToGpu,
  };
}

/** True when a running instance differs from what loading now would ask for. Unreported fields don't count; a context of 0 is one. */
export function lmStudioRunningConfigDiffers(running: LmStudioRunningConfig, wanted: LmStudioLoadOptions): boolean {
  return (Object.keys(wanted) as (keyof LmStudioLoadOptions)[]).some(
    (key) => running[key] !== undefined && running[key] !== 0 && wanted[key] !== undefined && running[key] !== wanted[key],
  );
}

/** Reasoning caps from what the model reports, in the shape the composer and backend already use. */
export function lmStudioReasoningCaps(
  card: Pick<LmStudioModelCard, 'reasoningOptions' | 'vision'>,
): ChatTemplateReasoningCaps {
  const options = card.reasoningOptions ?? [];
  const efforts = options.filter((o) => o === 'low' || o === 'medium' || o === 'high');
  return {
    enableThinking: options.includes('off') && options.length > 1,
    reasoningEffortValues: efforts.length ? efforts : null,
    ...(card.vision !== undefined ? { vision: card.vision } : {}),
  };
}

/** Key saved when the user gave no token; LM Studio ignores it unless Require Authentication is on. */
export const LM_STUDIO_PLACEHOLDER_API_KEY = 'lm-studio';

const LM_STUDIO_CTX_MAX = 10_000_000;

export function coerceLmStudioContextTokens(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return 0;
  }
  return Math.min(LM_STUDIO_CTX_MAX, Math.floor(n));
}

/** Prefer the loaded instance window; fall back to the model max. */
export function effectiveLmStudioContextTokens(
  card: Pick<LmStudioModelCard, 'max_context_length' | 'loaded_context_length'>,
): number {
  return coerceLmStudioContextTokens(card.loaded_context_length) || coerceLmStudioContextTokens(card.max_context_length);
}
