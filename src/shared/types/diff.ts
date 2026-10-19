/**
 * Side-by-side diff of the retired diff review card. Edits now land on disk directly and each turn
 * lists its edited files (turn-edits footer), so nothing emits this any more; the type stays so
 * `diff` / `staged_transfer_batch` messages saved in older conversations still load, show read-only
 * in the trail, and feed the restore fallback for conversations that predate the file journal.
 */

export type DiffRowKind = 'equal' | 'add' | 'remove' | 'replace';

export interface DiffRow {
  kind: DiffRowKind;
  leftLine: number | null;
  rightLine: number | null;
  leftText: string;
  rightText: string;
  hunkIndex: number;
}

export interface FileDiffPayload {
  version: 1;
  relativePath: string;
  language: string;
  rows: DiffRow[];
  /** Snapshot before the proposal (for incremental accept); optional for older saved conversations. */
  fullOriginalContent?: string;
  fullNewContent: string;
  truncated: boolean;
  baseSha256?: string;
  /** Python codec name used when writing `fullNewContent` to disk (default utf-8 for older payloads). */
  diskEncoding?: string;
  /** Resolved line ending for disk write (never `preserve` here). */
  diskNewline?: 'lf' | 'crlf';
  /** Retired staged code-review transfer flag (older saved conversations only). */
  stagedTransferHitl?: boolean;
}

/** Options for IPC workspace writes (aligned with diff payload / Python tools). */
export interface WorkspaceFileWriteOptions {
  encoding?: string;
  newline?: 'lf' | 'crlf';
}
