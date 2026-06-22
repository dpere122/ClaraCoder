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
  watchers: FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  /** Debounced watch batch; last kind wins per path within a batch. */
  pendingChanges: Map<string, WorkspaceChangeKind>;
  syncVersion: number;
  lastTree: string;
  lastSyncedAt: string | null;
  recentChanges: WorkspaceChangeRecord[];
}
