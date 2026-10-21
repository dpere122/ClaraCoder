import type { SubagentRef } from './subagent';

/** One path in a batch delete confirmation (mirrors Python pending entry). */
export interface DeleteConfirmEntry {
  relativePath: string;
  kind: 'file' | 'directory';
  recursive: boolean;
}

/** Payload for SSE `delete_confirm` / chat delete confirmation card (mirrors Python `delete_confirm_sse_payload`). */
export interface DeleteConfirmPayload {
  version: 1;
  requestId: string;
  /** Batch delete: one confirmation for all paths. */
  entries?: DeleteConfirmEntry[];
  /** Single-path delete when `entries` is absent. */
  relativePath?: string;
  kind?: 'file' | 'directory';
  recursive?: boolean;
  /** Set by main when a sub-agent asked; the answer goes to the sub-agent's session. */
  subagent?: SubagentRef;
}
