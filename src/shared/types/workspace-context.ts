/** Mutable accumulator while building a text tree for LLM context (depth/entry caps). */
export interface WorkspaceContextState {
  rootPath: string;
  maxDepth: number;
  maxEntries: number;
  entriesWritten: number;
  truncated: boolean;
  ignoreRules: string[];
}

export type WorkspaceChangeKind = 'created' | 'updated' | 'deleted' | 'renamed' | 'unknown';

/** Payload pushed to renderer when the debounced watcher fires. */
export interface WorkspaceFilesChangedPayload {
  workspaceId: string;
  workspacePath: string;
  paths: string[];
  kinds: WorkspaceChangeKind[];
}

/** One debounced batch of filesystem events for workspace state summary text. */
export interface WorkspaceChangeRecord {
  changedAt: string;
  paths: string[];
  kinds: WorkspaceChangeKind[];
}
