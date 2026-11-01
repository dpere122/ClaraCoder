import type { ChatTemplateReasoningCaps } from './chat-template-reasoning';
import type { LlmProviderConfig } from './types/app-config';

/** One row from the Claude Models API (``GET /v1/models``), reduced to what Settings shows. */
export interface AnthropicCatalogModel {
  id: string;
  displayName: string;
  /** ISO timestamp the model was released. */
  createdAt?: string;
  /** Context window (``max_input_tokens``); 0 when the API did not say. */
  maxInputTokens: number;
  /** Output cap (``max_tokens``); 0 when the API did not say. */
  maxOutputTokens: number;
  /** Model line from the API (``opus``, ``sonnet``, ``haiku``, …), when it has one. */
  line?: string;
  /** ``deprecated`` models still work for existing users but are headed for retirement. */
  deprecated: boolean;
  /** Scheduled retirement (ISO timestamp), when one is set. */
  retiresAt?: string;
  vision: boolean;
  adaptiveThinking: boolean;
  /** Effort levels the model accepts, lowest to highest. Empty when it has no effort control. */
  effortLevels: string[];
  structuredOutputs: boolean;
}

/**
 * Where the API key lives: ``keychain`` is encrypted on disk with the OS keychain
 * (Electron ``safeStorage``), ``session`` is held in memory only because the keychain is
 * unavailable (lost on restart), ``none`` means no key is set.
 */
export type AnthropicKeyStorage = 'keychain' | 'session' | 'none';

/** What Settings shows about the Claude connection. The key itself never leaves main. */
export interface AnthropicStatus {
  configured: boolean;
  storage: AnthropicKeyStorage;
  /** ``sk-ant-…abcd``, or empty when no key is set. */
  keyHint: string;
  /** Models the key can use; empty until a list succeeds. */
  models: AnthropicCatalogModel[];
  /** Unix ms of the last successful model list. */
  verifiedAt?: number;
  /** Last list error (bad key, network), if the most recent check failed. */
  error?: string;
}

export type AnthropicListModelsResult =
  | { ok: true; status: AnthropicStatus }
  | { ok: false; error: string; status: AnthropicStatus };

export type AnthropicSetKeyResult = AnthropicListModelsResult;

export type AnthropicSetModelResult = { ok: true } | { ok: false; error: string };

/** Claude effort tokens, lowest to highest (the composer lists them in this order). */
export const ANTHROPIC_EFFORT_ORDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Composer/backend caps for a Claude model: no on/off toggle (current models think adaptively and
 * some cannot turn it off; effort is the control), and the effort dropdown lists only what the
 * Models API advertises.
 */
export function anthropicReasoningCaps(model: AnthropicCatalogModel | undefined): ChatTemplateReasoningCaps {
  return {
    enableThinking: false,
    reasoningEffortValues: model?.effortLevels.length ? [...model.effortLevels] : null,
    adaptiveThinking: model?.adaptiveThinking === true,
  };
}

/** Source picker label for the Claude row: ``Claude · <model>``, or just the source name. */
export function anthropicSourceLabel(provider: LlmProviderConfig): string {
  const profile = provider.models[0];
  const modelId = (profile?.model ?? '').trim();
  if (!modelId) {
    return provider.name;
  }
  const name = (profile?.name ?? '').trim();
  const model = name && name !== provider.name ? name.replace(/^Claude\s+/i, '') : modelId;
  return `${provider.name} · ${model}`;
}
