import type { ConversationMessage, LlmConnectionConfig, StreamPart } from '@shared/index';
import { resolveContextWindowTokens } from '@shared/index';

const MESSAGE_OVERHEAD_TOKENS = 8;
const STREAM_OVERHEAD_TOKENS = 4;
const WORKSPACE_OVERHEAD_TOKENS = 16;
const TOOL_ARTIFACT_OVERHEAD_TOKENS = 12;

export interface ContextCapacitySnapshot {
  usedTokens: number;
  maxTokens: number;
  remainingTokens: number;
  usedPercentage: number;
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

export function buildContextCapacitySnapshot(args: {
  connection: Pick<LlmConnectionConfig, 'contextWindowTokens' | 'model' | 'provider'> | null | undefined;
  messages: ConversationMessage[];
  streamingParts: StreamPart[];
  workspaceContextText: string;
}): ContextCapacitySnapshot {
  const maxTokens = resolveContextWindowTokens(args.connection);
  const messageTokens = args.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const streamTokens = estimateStreamTokens(args.streamingParts);
  const workspaceTokens = args.workspaceContextText.trim()
    ? WORKSPACE_OVERHEAD_TOKENS + estimateTextTokens(args.workspaceContextText)
    : 0;
  const usedTokens = Math.min(maxTokens, messageTokens + streamTokens + workspaceTokens);
  const remainingTokens = Math.max(0, maxTokens - usedTokens);
  const usedPercentage = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0;

  return {
    usedTokens,
    maxTokens,
    remainingTokens,
    usedPercentage,
  };
}
