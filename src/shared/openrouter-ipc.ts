import type { ChatTemplateReasoningCaps } from './chat-template-reasoning';

/**
 * Per-model ``reasoning`` block from OpenRouter ``GET /api/v1/models``. Models that cannot
 * reason omit the block entirely.
 */
export interface OpenRouterReasoningInfo {
  /** Reasoning cannot be turned off; the API rejects ``effort: "none"`` for these models. */
  mandatory: boolean;
  /** Effort levels the model accepts. Empty when it only takes on/off or a token budget. */
  supportedEfforts: string[];
  defaultEffort?: string;
  defaultEnabled?: boolean;
}

/** One row from OpenRouter ``GET /api/v1/models``. */
export interface OpenRouterCatalogModel {
  id: string;
  name: string;
  contextLength: number;
  reasoning?: OpenRouterReasoningInfo;
}

export type OpenRouterListModelsResult =
  | { ok: true; models: OpenRouterCatalogModel[] }
  | { ok: false; error: string };

/** OpenRouter effort tokens, lowest to highest (the composer lists them in this order). */
const OPENROUTER_EFFORT_ORDER: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Maps OpenRouter's reasoning metadata onto the caps the composer and backend already use for
 * llama.cpp chat templates: the on/off toggle shows only when reasoning is optional, and the
 * effort dropdown lists only advertised levels. ``none`` is the off switch, so the toggle owns it.
 */
export function openRouterReasoningCaps(reasoning: OpenRouterReasoningInfo | undefined): ChatTemplateReasoningCaps {
  if (!reasoning) {
    return { enableThinking: false, reasoningEffortValues: null };
  }
  const advertised = new Set(reasoning.supportedEfforts);
  const efforts = OPENROUTER_EFFORT_ORDER.filter((effort) => advertised.has(effort));
  return {
    enableThinking: !reasoning.mandatory,
    reasoningEffortValues: efforts.length ? efforts : null,
  };
}
