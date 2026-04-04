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
    };

/** Full conversation as used in the renderer. */
export interface Conversation extends ConversationMeta {
  messages: ConversationMessage[];
  workspaceId: string | null;
  themeId: string;
}

/**
 * On-disk JSON shape used by the main process (simpler message rows than the UI model).
 * Loaded/saved via IPC; Python history sync uses user/assistant roles only.
 */
export interface ConversationFile {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: { role: string; text: string }[];
  workspaceId: string | null;
  themeId: string;
}

/** Minimal fields for “recent conversations” menu aggregation. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}
