/**
 * The composer as one conversation left it: its draft, run mode, Auto Run, Admin, model and thinking.
 * Stored with the conversation (`composer_json`) and restored when it is opened again.
 */
import { COMPOSER_RUN_MODES, DEFAULT_COMPOSER_RUN_MODE, type ComposerRunMode } from './types/composer-mode';
import type { AppConfig, GemmaThinkingMode, LlmReasoningEffort } from './types/app-config';

export interface ConversationComposerState {
  /** Text typed but not sent yet. */
  draft: string;
  mode: ComposerRunMode;
  /** Auto Run: tool calls run without an approval card (off in Ask mode). */
  autoApply: boolean;
  /** The Admin chip: elevated `run_command` for this conversation. */
  admin: boolean;
  /** Thinking on or off for this conversation; absent: the source's own setting in Settings. */
  thinkingMode?: GemmaThinkingMode;
  /** Reasoning level for this conversation; absent: the source's own setting in Settings. */
  reasoningEffort?: LlmReasoningEffort;
  /**
   * The model this conversation runs on (a model preset id, as `activeLlmModelId`); absent until
   * the conversation is first opened, when it takes the app's active model.
   */
  modelId?: string;
  /** With the Claude source: which Claude model (that source keeps one id for all of them). */
  claudeModel?: string;
}

/** A conversation's thinking settings (absent fields: the source's own). */
export type ConversationThinking = Pick<ConversationComposerState, 'thinkingMode' | 'reasoningEffort'>;

/** What a turn sends besides its text: the conversation's model and thinking (absent: the app's own). */
export type ConversationTurnSettings = Pick<
  ConversationComposerState,
  'modelId' | 'claudeModel' | 'thinkingMode' | 'reasoningEffort'
>;

/** The model a conversation is on, as a turn or a model switch needs it. */
export type ConversationModel = Pick<ConversationComposerState, 'modelId' | 'claudeModel'>;

export const DEFAULT_CONVERSATION_COMPOSER: Readonly<ConversationComposerState> = Object.freeze({
  draft: '',
  mode: DEFAULT_COMPOSER_RUN_MODE,
  autoApply: false,
  admin: false,
});

/** Longest model id or Claude model name kept (ids are UUIDs, names short API ids). */
const MAX_MODEL_ID_LENGTH = 200;

const THINKING_MODES: ReadonlySet<string> = new Set<GemmaThinkingMode>(['default', 'on', 'off']);
const REASONING_EFFORTS: ReadonlySet<string> = new Set<LlmReasoningEffort>([
  '',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'on',
  'off',
]);

/** A stored or received composer state, or null when there is none (unknown fields fall back to defaults). */
export function normalizeConversationComposer(raw: unknown): ConversationComposerState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const mode = (COMPOSER_RUN_MODES as readonly unknown[]).includes(row['mode'])
    ? (row['mode'] as ComposerRunMode)
    : DEFAULT_COMPOSER_RUN_MODE;
  const state: ConversationComposerState = {
    draft: typeof row['draft'] === 'string' ? row['draft'] : '',
    mode,
    // Ask mode never runs tools on its own.
    autoApply: mode !== 'ask' && row['autoApply'] === true,
    admin: row['admin'] === true,
  };
  const thinking = row['thinkingMode'];
  if (typeof thinking === 'string' && THINKING_MODES.has(thinking)) {
    state.thinkingMode = thinking as GemmaThinkingMode;
  }
  const effort = row['reasoningEffort'];
  if (typeof effort === 'string' && REASONING_EFFORTS.has(effort)) {
    state.reasoningEffort = effort as LlmReasoningEffort;
  }
  const modelId = modelText(row['modelId']);
  if (modelId) {
    state.modelId = modelId;
    const claudeModel = modelText(row['claudeModel']);
    if (claudeModel) {
      state.claudeModel = claudeModel;
    }
  }
  return state;
}

function modelText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text.length <= MAX_MODEL_ID_LENGTH ? text : '';
}

/**
 * What a new conversation's composer starts as: the run mode, Auto Run, model and thinking of the
 * one the user was in, with an empty draft. Admin starts off: it is granted per conversation.
 */
export function newConversationComposer(from: ConversationComposerState | null | undefined): ConversationComposerState {
  const base = from ?? DEFAULT_CONVERSATION_COMPOSER;
  const state: ConversationComposerState = { draft: '', mode: base.mode, autoApply: base.autoApply, admin: false };
  for (const key of ['thinkingMode', 'reasoningEffort', 'modelId', 'claudeModel'] as const) {
    if (base[key] !== undefined) {
      (state as unknown as Record<string, unknown>)[key] = base[key];
    }
  }
  return state;
}

/** The model the app is on: its active model preset, and the Claude model when that is the Claude source. */
export function activeConversationModel(config: Pick<AppConfig, 'activeLlmModelId' | 'llmProviders'>): ConversationModel {
  const modelId = config.activeLlmModelId?.trim() ?? '';
  if (!modelId) {
    return {};
  }
  const provider = config.llmProviders.find((p) => p.models.some((m) => m.id === modelId));
  const claudeModel = provider?.provider === 'anthropic' ? provider.models.find((m) => m.id === modelId)?.model : undefined;
  return claudeModel ? { modelId, claudeModel } : { modelId };
}

export function sameConversationModel(a: ConversationModel, b: ConversationModel): boolean {
  return (a.modelId ?? '') === (b.modelId ?? '') && (a.claudeModel ?? '') === (b.claudeModel ?? '');
}

export function sameConversationComposer(a: ConversationComposerState, b: ConversationComposerState): boolean {
  return (
    a.draft === b.draft &&
    a.mode === b.mode &&
    a.autoApply === b.autoApply &&
    a.admin === b.admin &&
    a.thinkingMode === b.thinkingMode &&
    a.reasoningEffort === b.reasoningEffort &&
    a.modelId === b.modelId &&
    a.claudeModel === b.claudeModel
  );
}
