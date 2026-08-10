import type { ConversationMessage, LlmConnectionConfig, StreamPart } from '@shared/index';
import { resolveContextWindowTokens } from '@shared/index';

const MESSAGE_OVERHEAD_TOKENS = 8;
const STREAM_OVERHEAD_TOKENS = 4;
const WORKSPACE_OVERHEAD_TOKENS = 16;
const TOOL_ARTIFACT_OVERHEAD_TOKENS = 12;

/** At or above this percentage, new chat messages are blocked. */
export const CONTEXT_CHAT_BLOCKED_PERCENT = 95;

export interface ContextCapacitySnapshot {
  usedTokens: number;
  maxTokens: number;
  remainingTokens: number;
  usedPercentage: number;
  /**
   * True when ``usedTokens`` is anchored to API usage metadata (or a delta from it after
   * checkpoint compaction), not a pure transcript heuristic.
   */
  measuredFromApi: boolean;
}

function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.ceil(normalized.length / 4);
}

function estimateMessageTokens(message: ConversationMessage): number {
  switch (message.role) {
    case 'user':
    case 'assistant': {
      const plannerTokens = message.role === 'assistant' && message.planner
        ? estimateTextTokens(JSON.stringify(message.planner))
        : 0;
      return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.text) + plannerTokens;
    }
    case 'chain':
      return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(`${message.label}\n${message.text}`);
    case 'diff':
    case 'accept_command':
    case 'copy_confirm':
    case 'delete_confirm':
    case 'plan_confirm':
    case 'agent_question':
    case 'staged_transfer_batch':
      return (
        TOOL_ARTIFACT_OVERHEAD_TOKENS +
        estimateTextTokens(JSON.stringify(message.payload)) +
        estimateTextTokens(message.reviewSummary ?? '') +
        estimateTextTokens(message.reviewStatus ?? '')
      );
  }
}

function estimateStreamTokens(parts: StreamPart[]): number {
  return parts.reduce(
    (sum, part) => sum + STREAM_OVERHEAD_TOKENS + estimateTextTokens(`${part.label}\n${part.text}`),
    0,
  );
}

/** Heuristic transcript token estimate (messages + live stream + workspace context). */
export function estimateTranscriptContextTokens(args: {
  messages: ConversationMessage[];
  streamingParts: StreamPart[];
  workspaceContextText: string;
}): number {
  const messageTokens = args.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const streamTokens = estimateStreamTokens(args.streamingParts);
  const workspaceTokens = args.workspaceContextText.trim()
    ? WORKSPACE_OVERHEAD_TOKENS + estimateTextTokens(args.workspaceContextText)
    : 0;
  return messageTokens + streamTokens + workspaceTokens;
}

export function buildContextCapacitySnapshot(args: {
  connection: Pick<LlmConnectionConfig, 'contextWindowTokens' | 'model' | 'provider'> | null | undefined;
  messages: ConversationMessage[];
  streamingParts: StreamPart[];
  workspaceContextText: string;
  /** Latest prompt-side token count from the chat API (full context sent to the model on the last completion). */
  measuredPromptTokens?: number | null;
  /**
   * Transcript estimate captured when ``measuredPromptTokens`` was last set. Growth of the
   * transcript above this baseline is added so the meter keeps moving after a measurement
   * (e.g. mid-turn tool output) without treating checkpoint-only compaction estimates as absolute.
   */
  measuredBaselineFallbackTokens?: number | null;
}): ContextCapacitySnapshot {
  const maxTokens = resolveContextWindowTokens(args.connection);
  const fallbackUsed = Math.min(
    maxTokens,
    estimateTranscriptContextTokens({
      messages: args.messages,
      streamingParts: args.streamingParts,
      workspaceContextText: args.workspaceContextText,
    }),
  );
  const measured =
    typeof args.measuredPromptTokens === 'number' &&
    Number.isFinite(args.measuredPromptTokens) &&
    args.measuredPromptTokens > 0
      ? Math.floor(args.measuredPromptTokens)
      : null;
  let usedTokens: number;
  let measuredFromApi: boolean;
  if (measured !== null) {
    const baselineRaw = args.measuredBaselineFallbackTokens;
    const baseline =
      typeof baselineRaw === 'number' && Number.isFinite(baselineRaw) && baselineRaw >= 0
        ? Math.floor(baselineRaw)
        : fallbackUsed;
    const growth = Math.max(0, fallbackUsed - baseline);
    usedTokens = Math.min(maxTokens, measured + growth);
    measuredFromApi = true;
  } else {
    usedTokens = fallbackUsed;
    measuredFromApi = false;
  }
  const remainingTokens = Math.max(0, maxTokens - usedTokens);
  const usedPercentage = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0;

  return {
    usedTokens,
    maxTokens,
    remainingTokens,
    usedPercentage,
    measuredFromApi,
  };
}
