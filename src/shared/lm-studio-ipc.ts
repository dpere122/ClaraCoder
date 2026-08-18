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
}

export type LmStudioListModelsResult =
  | { ok: true; origin: string; source: 'v1' | 'v0'; models: LmStudioModelCard[] }
  | { ok: false; error: string };

export type LmStudioMutationResult = { ok: true } | { ok: false; error: string };

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
