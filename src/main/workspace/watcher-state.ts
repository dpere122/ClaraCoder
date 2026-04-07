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
  watchers: FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  pendingPaths: Set<string>;
  pendingKinds: Set<WorkspaceChangeKind>;
  syncVersion: number;
  lastTree: string;
  lastSyncedAt: string | null;
  recentChanges: WorkspaceChangeRecord[];
}
