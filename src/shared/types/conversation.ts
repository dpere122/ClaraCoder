import type { FileDiffPayload } from './diff';
import type { LlmAgentRole } from './llm';

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
  | { role: 'user' | 'assistant'; text: string }
  | {
      role: 'chain';
      label: string;
      text: string;
      state: 'running' | 'complete' | 'error';
      source: 'agent' | 'tool';
      statusId: string;
      agentRole?: LlmAgentRole;
    }
  | {
      role: 'diff';
      payload: FileDiffPayload;
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
  | { role: 'user' | 'assistant'; text: string }
  | {
      role: 'chain';
      label: string;
      text: string;
      state: 'running' | 'complete' | 'error';
      source: 'agent' | 'tool';
      statusId: string;
      agentRole?: LlmAgentRole;
    }
  | {
      role: 'diff';
      payload: FileDiffPayload;
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
