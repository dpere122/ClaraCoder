import type { FileDiffPayload } from './diff';
import type { AcceptCommandPayload } from './accept-command';
import type { CopyConfirmPayload } from './copy-confirm';
import type { DeleteConfirmPayload } from './delete-confirm';
import type { LlmAgentRole, PlannerProgress } from './llm';

/** One labeled segment of an in-flight assistant reply (multiplexed LLM subgraphs share one bubble). */
export interface StreamPart {
  streamTag: string;
  label: string;
  text: string;
}

/** Lifecycle of a proposed edit card in the chat transcript. */
export type DiffReviewStatus = 'pending' | 'complete' | 'cancelled';

/** List row / sidebar metadata for a conversation. */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string | null;
}

/** One message in the chat UI (user/assistant text or tool chain row). */
export type ConversationMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; planner?: PlannerProgress }
  | {
      role: 'chain';
      label: string;
      text: string;
      state: 'running' | 'complete' | 'error';
      source: 'agent' | 'tool';
      statusId: string;
      agentRole?: LlmAgentRole;
      streamTag?: string;
    }
  | {
      role: 'diff';
      payload: FileDiffPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'accept_command';
      payload: AcceptCommandPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'copy_confirm';
      payload: CopyConfirmPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'delete_confirm';
      payload: DeleteConfirmPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    };

/** Full conversation as used in the renderer. */
export interface Conversation extends ConversationMeta {
  messages: ConversationMessage[];
  workspaceId: string | null;
  themeId: string;
}

/** Serialized chat row in conversation JSON (includes tool/diff metadata). */
export type ConversationFileMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; planner?: PlannerProgress }
  | {
      role: 'chain';
      label: string;
      text: string;
      state: 'running' | 'complete' | 'error';
      source: 'agent' | 'tool';
      statusId: string;
      agentRole?: LlmAgentRole;
      streamTag?: string;
    }
  | {
      role: 'diff';
      payload: FileDiffPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'accept_command';
      payload: AcceptCommandPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'copy_confirm';
      payload: CopyConfirmPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'delete_confirm';
      payload: DeleteConfirmPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    };

/**
 * On-disk JSON shape used by the main process.
 * Loaded/saved via IPC; Python history sync uses user/assistant roles only.
 */
export interface ConversationFile {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationFileMessage[];
  workspaceId: string | null;
  themeId: string;
}

/** Minimal fields for “recent conversations” menu aggregation. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}
