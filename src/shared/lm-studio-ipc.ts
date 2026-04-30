/** Normalized row for Settings UI (v0 and v1 LM Studio REST). */
export interface LmStudioModelCard {
  id: string;
  type: string;
  publisher: string;
  arch: string;
  compatibility_type: string;
  quantization: string;
  state: string;
  max_context_length: number;
  /** Present when loaded; use for POST /api/v1/models/unload. */
  instanceId?: string;
}

export type LmStudioListModelsResult =
  | { ok: true; origin: string; source: 'v1' | 'v0'; models: LmStudioModelCard[] }
  | { ok: false; error: string };

export type LmStudioMutationResult = { ok: true } | { ok: false; error: string };
