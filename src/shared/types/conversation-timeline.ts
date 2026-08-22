/** One landed workspace mutation attributed to a user turn. */
export type ConversationFileJournalOp = 'create' | 'modify' | 'delete' | 'delete-tree' | 'copy';

/** One file inside a deleted directory snapshot. */
export interface ConversationFileJournalTreeEntry {
  relativePath: string;
  content: string;
  encoding?: string;
  newline?: 'lf' | 'crlf';
}

/** Journal row stored in SQLite and sent over SSE / IPC. */
export interface ConversationFileJournalEntry {
  conversationId?: string;
  userMessageId: string;
  seq: number;
  relativePath: string;
  op: ConversationFileJournalOp;
  beforeContent?: string | null;
  beforeEncoding?: string;
  beforeNewline?: 'lf' | 'crlf';
  destRelativePath?: string;
  treeEntries?: ConversationFileJournalTreeEntry[];
}

/** Payload appended from the renderer or Python `file_journal` SSE (seq assigned in main). */
export interface AppendConversationFileJournalRequest {
  conversationId: string;
  userMessageId: string;
  op: ConversationFileJournalOp;
  relativePath: string;
  beforeContent?: string | null;
  beforeEncoding?: string;
  beforeNewline?: 'lf' | 'crlf';
  destRelativePath?: string;
  treeEntries?: ConversationFileJournalTreeEntry[];
}

export interface RestoreConversationTimelineRequest {
  conversationId: string;
  userMessageId?: string;
  /** Raw index into `conversation.messages` (must be a user row). */
  userMessageIndex?: number;
}

export type RestoreConversationTimelineResult =
  | {
      ok: true;
      messages: import('./conversation').ConversationMessage[];
      revertedPaths: string[];
      skippedPaths: string[];
    }
  | { ok: false; error: string };

/** Disk action produced by inverting journal rows after a restore point. */
export type ConversationTimelineInvertAction =
  | {
      kind: 'write';
      relativePath: string;
      content: string;
      encoding?: string;
      newline?: 'lf' | 'crlf';
    }
  | { kind: 'delete'; relativePath: string }
  | { kind: 'write-tree'; entries: ConversationFileJournalTreeEntry[] }
  | { kind: 'skip'; relativePath: string; reason: string };
