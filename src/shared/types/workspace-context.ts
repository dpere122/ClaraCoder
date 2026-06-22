/** Mutable accumulator while building a text tree for LLM context (depth/entry caps). */
export interface WorkspaceContextState {
  rootPath: string;
  maxDepth: number;
  maxEntries: number;
  entriesWritten: number;
  truncated: boolean;
  ignoreRules: string[];
  /** When true, built-in and `.gitignore` filters are not applied while building the tree. */
  exposeAllWorkspaceFiles: boolean;
}

export type WorkspaceChangeKind = 'created' | 'updated' | 'deleted' | 'renamed' | 'unknown';

/** Payload pushed to renderer when the debounced watcher fires. */
export interface WorkspaceFilesChangedPayload {
  workspaceId: string;
  workspacePath: string;
  paths: string[];
  kinds: WorkspaceChangeKind[];
  /** Workspace-relative path before a rename/move, aligned with {@link paths} when present. */
  previousPaths?: string[];
}

/** One debounced batch of filesystem events for workspace state summary text. */
export interface WorkspaceChangeRecord {
  changedAt: string;
  paths: string[];
  kinds: WorkspaceChangeKind[];
}

/** Paths + kinds forwarded to Python for incremental semantic indexing (optional). */
export interface WorkspaceFileChangesForSync {
  paths: string[];
  kinds: string[];
}

/** Optional fields when POSTing workspace context to the Python backend. */
export interface WorkspaceContextSyncExtras {
  workspaceId?: string;
  workspaceFileChanges?: WorkspaceFileChangesForSync;
  /** When set, applies this interpreter to the session (LSP env); persisted per workspace in config. */
  pythonInterpreterId?: string;
}

/** One row from `GET /session/python-interpreters`. */
export interface PythonInterpreterListItem {
  id: string;
  label: string;
  pythonExecutable: string;
  venvPath: string;
}
