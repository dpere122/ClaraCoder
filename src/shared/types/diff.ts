/** Side-by-side diff emitted from Python (`type: diff` SSE) and stored on conversation messages. */

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
}

/** Options for IPC workspace writes (aligned with diff payload / Python tools). */
export interface WorkspaceFileWriteOptions {
  encoding?: string;
  newline?: 'lf' | 'crlf';
}
