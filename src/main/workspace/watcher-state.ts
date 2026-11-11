import type { FSWatcher } from 'fs';
import type { WorkspaceChangeKind, WorkspaceChangeRecord } from '../../shared';

/**
 * Live workspace filesystem watch: debounced sync to Python + `workspace-files-changed` to renderer.
 */
export interface WorkspaceWatcherState {
  workspaceId: string;
  workspacePath: string;
  stagingPath: string;
  /** Root `.gitignore` patterns (same subset as context tree); refreshed when root `.gitignore` changes. */
  ignoreRules: string[];
  /** When true, built-in and `.gitignore` filters are skipped for tree sync and workspace watch batches. */
  exposeAllWorkspaceFiles: boolean;
  /**
   * Confirmation gate for expose-all: ignore filters are cleared only when this is true
   * together with the config exposeAll flag. Secrets denylist still applies.
   */
  exposeAllConfirmed: boolean;
  watchers: FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  /** Debounced watch batch: one kind per path, see {@link batchedChangeKind}. */
  pendingChanges: Map<string, WorkspaceChangeKind>;
  syncVersion: number;
  lastTree: string;
  lastSyncedAt: string | null;
  recentChanges: WorkspaceChangeRecord[];
}

/**
 * The kind a path has in a watch batch: the last one, except that writing a file just created leaves it new.
 * A plain new file arrives as created then updated, and what is new is what the frozen prompt tree needs told.
 */
export function batchedChangeKind(
  previous: WorkspaceChangeKind | undefined,
  next: WorkspaceChangeKind,
): WorkspaceChangeKind {
  return previous === 'created' && next === 'updated' ? 'created' : next;
}
