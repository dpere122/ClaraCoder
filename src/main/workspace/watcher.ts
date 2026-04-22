import path = require('path');
const syncFs = require('fs');
import type {
  ConversationFile,
  Workspace,
  WorkspaceContextState,
  WorkspaceFilesChangedPayload,
} from '../../shared';
import {
  WORKSPACE_CONTEXT_MAX_DEPTH,
  WORKSPACE_CONTEXT_MAX_ENTRIES,
  WORKSPACE_CHANGE_HISTORY_LIMIT,
  WORKSPACE_CONTEXT_IGNORED_NAMES,
  WORKSPACE_CONTEXT_IGNORED_SUFFIXES,
  WORKSPACE_WATCH_DEBOUNCE_MS,
} from '../constants';
import { getWorkspaceStagingDir } from '../paths';
import { mainState } from '../state';
import { loadConfig } from '../config/load-save';
import { syncWorkspaceContextToPython } from '../python/workspace-sync';
import { buildWorkspaceTree } from './context-tree';
import { loadWorkspaceIgnoreRules, normalizeContextPath, shouldIgnoreWorkspaceEntry } from './ignore-rules';
import type { WorkspaceWatcherState } from './watcher-state';
import type { WorkspaceChangeKind } from '../../shared';

export type { WorkspaceWatcherState };

type WatchSource = 'workspace' | 'staging';

export function clearWorkspaceWatcher(): void {
  const w = mainState.activeWorkspaceWatcher;
  if (!w) return;
  if (w.debounceTimer) {
    clearTimeout(w.debounceTimer);
  }
  for (const watcher of w.watchers) {
    watcher.close();
  }
  mainState.activeWorkspaceWatcher = null;
}

function isRootGitignoreWatchPath(relativePath: string): boolean {
  const n = normalizeContextPath(relativePath)
    .replace(/^[/\\]+/, '')
    .replace(/^\.\/+/, '');
  const segments = n.split('/').filter((s) => s && s !== '.');
  return segments.length === 1 && segments[0] === '.gitignore';
}

async function syncWatchedWorkspaceTree(
  watcherState: WorkspaceWatcherState,
  changePayload?: WorkspaceFilesChangedPayload,
): Promise<void> {
  const syncVersion = ++watcherState.syncVersion;
  const changedAt = new Date().toISOString();

  try {
    if (changePayload?.paths.some((p) => !p.startsWith('[staging] ') && isRootGitignoreWatchPath(p))) {
      watcherState.ignoreRules = await loadWorkspaceIgnoreRules(watcherState.workspacePath);
    }

    const tree = await buildWatchedContextSnapshot(watcherState.workspacePath, watcherState.stagingPath);
    if (mainState.activeWorkspaceWatcher !== watcherState || watcherState.syncVersion !== syncVersion) {
      return;
    }

    watcherState.lastTree = tree;
    watcherState.lastSyncedAt = changedAt;

    if (changePayload && (changePayload.paths.length > 0 || changePayload.kinds.length > 0)) {
      watcherState.recentChanges.unshift({
        changedAt,
        paths: [...changePayload.paths],
        kinds: [...changePayload.kinds],
      });
      watcherState.recentChanges = watcherState.recentChanges.slice(0, WORKSPACE_CHANGE_HISTORY_LIMIT);
    }

    if (
      mainState.activeConversationId &&
      mainState.activeConversationWorkspaceId === watcherState.workspaceId
    ) {
      try {
        await syncWorkspaceContextToPython(mainState.activeConversationId, watcherState.workspacePath, tree, {
          workspaceId: watcherState.workspaceId,
          workspaceFileChanges:
            changePayload && (changePayload.paths.length > 0 || changePayload.kinds.length > 0)
              ? { paths: [...changePayload.paths], kinds: [...changePayload.kinds] }
              : undefined,
        });
      } catch (err) {
        console.error('Failed to sync watched workspace context:', err);
      }
    }

    if (changePayload) {
      mainState.mainWindow?.webContents.send('workspace-files-changed', changePayload);
    }
  } catch (err) {
    console.error('Failed to rebuild watched workspace tree:', err);
  }
}

function queueWorkspaceWatcherSync(watcherState: WorkspaceWatcherState): void {
  if (watcherState.debounceTimer) {
    clearTimeout(watcherState.debounceTimer);
  }

  watcherState.debounceTimer = setTimeout(() => {
    watcherState.debounceTimer = null;
    const changePayload: WorkspaceFilesChangedPayload = {
      workspaceId: watcherState.workspaceId,
      workspacePath: watcherState.workspacePath,
      paths: Array.from(watcherState.pendingPaths).sort(),
      kinds: Array.from(watcherState.pendingKinds),
    };
    watcherState.pendingPaths.clear();
    watcherState.pendingKinds.clear();
    void syncWatchedWorkspaceTree(watcherState, changePayload);
  }, WORKSPACE_WATCH_DEBOUNCE_MS);
}

function getWorkspaceChangeKind(eventType: string): WorkspaceChangeKind {
  if (eventType === 'rename') return 'renamed';
  if (eventType === 'change') return 'updated';
  return 'unknown';
}

function createTreeState(rootPath: string, ignoreRules: string[]): WorkspaceContextState {
  return {
    rootPath,
    maxDepth: WORKSPACE_CONTEXT_MAX_DEPTH,
    maxEntries: WORKSPACE_CONTEXT_MAX_ENTRIES,
    entriesWritten: 0,
    truncated: false,
    ignoreRules,
  };
}

async function buildWatchedContextSnapshot(workspacePath: string, stagingPath: string): Promise<string> {
  syncFs.mkdirSync(stagingPath, { recursive: true });

  const workspaceTree = await buildWorkspaceTree(workspacePath);
  const stagingTree = await buildWorkspaceTree(stagingPath, '', 0, createTreeState(stagingPath, []));

  const trimmedWorkspaceTree = workspaceTree.trimEnd() || '[empty]';
  const trimmedStagingTree = stagingTree.trimEnd() || '[empty]';

  return [
    `Workspace tree (${workspacePath}):`,
    trimmedWorkspaceTree,
    '',
    `Nested edit staging tree (${stagingPath}):`,
    trimmedStagingTree,
    '',
    'Treat the staging tree as live pending-edit context; files there may not yet exist in the workspace.',
  ].join('\n');
}

function formatWatchedPath(source: WatchSource, relativePath: string): string {
  const normalizedRelativePath = relativePath ? normalizeContextPath(relativePath) : '.';
  return source === 'staging' ? `[staging] ${normalizedRelativePath}` : normalizedRelativePath;
}

function shouldProcessWorkspaceWatchPath(
  workspacePath: string,
  relativePath: string,
  ignoreRules: string[],
): boolean {
  const normalizedRelativePath = normalizeContextPath(relativePath).replace(/^\/+/, '');
  if (!normalizedRelativePath) {
    return true;
  }

  const pathSegments = normalizedRelativePath.split('/').filter(Boolean);
  const entryName = pathSegments[pathSegments.length - 1];
  const firstSegment = pathSegments[0] ?? entryName;

  if (WORKSPACE_CONTEXT_IGNORED_NAMES.has(firstSegment) || WORKSPACE_CONTEXT_IGNORED_NAMES.has(entryName)) {
    return false;
  }

  if (WORKSPACE_CONTEXT_IGNORED_SUFFIXES.some((suffix) => entryName.endsWith(suffix))) {
    return false;
  }

  const normalizedWorkspacePath = normalizeContextPath(workspacePath);
  const rootRelativePath = path.relative(
    normalizedWorkspacePath,
    path.join(normalizedWorkspacePath, normalizedRelativePath),
  );

  return !shouldIgnoreWorkspaceEntry(entryName, rootRelativePath, ignoreRules);
}

function createDirectoryWatcher(
  watcherState: WorkspaceWatcherState,
  rootPath: string,
  source: WatchSource,
): import('fs').FSWatcher {
  return syncFs.watch(
    rootPath,
    { recursive: true },
    (eventType: string, filename: string | Buffer | undefined) => {
      const aw = mainState.activeWorkspaceWatcher;
      if (!aw || aw !== watcherState) {
        return;
      }

      const relativePath = filename ? filename.toString() : '';
      if (
        source === 'workspace' &&
        relativePath &&
        !shouldProcessWorkspaceWatchPath(watcherState.workspacePath, relativePath, aw.ignoreRules)
      ) {
        return;
      }

      const changeKind = getWorkspaceChangeKind(eventType);
      aw.pendingPaths.add(formatWatchedPath(source, relativePath));
      aw.pendingKinds.add(changeKind);
      queueWorkspaceWatcherSync(aw);
    },
  );
}

export async function startWorkspaceWatcher(workspace: Workspace): Promise<void> {
  clearWorkspaceWatcher();

  const stagingPath = getWorkspaceStagingDir();
  syncFs.mkdirSync(stagingPath, { recursive: true });

  let ignoreRules: string[];
  try {
    ignoreRules = await loadWorkspaceIgnoreRules(workspace.path);
  } catch {
    ignoreRules = [];
  }

  try {
    const watcherState: WorkspaceWatcherState = {
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      stagingPath,
      ignoreRules,
      watchers: [],
      debounceTimer: null,
      pendingPaths: new Set(),
      pendingKinds: new Set(),
      syncVersion: 0,
      lastTree: '',
      lastSyncedAt: null,
      recentChanges: [],
    };

    const workspaceWatcher = createDirectoryWatcher(watcherState, workspace.path, 'workspace');
    workspaceWatcher.on('error', (err: Error) => {
      console.error('Workspace watcher error:', err);
    });

    const stagingWatcher = createDirectoryWatcher(watcherState, stagingPath, 'staging');
    stagingWatcher.on('error', (err: Error) => {
      console.error('Workspace staging watcher error:', err);
    });

    watcherState.watchers = [workspaceWatcher, stagingWatcher];
    mainState.activeWorkspaceWatcher = watcherState;

    void syncWatchedWorkspaceTree(mainState.activeWorkspaceWatcher);
  } catch (err) {
    console.error('Failed to start workspace watcher:', err);
    mainState.activeWorkspaceWatcher = null;
  }
}

/** (Re)attach watcher when the current workspace changes; no-op if path unchanged. */
export async function refreshWorkspaceWatcherForCurrentConfig(config?: import('../../shared').AppConfig): Promise<void> {
  const resolvedConfig = config ?? (await loadConfig());
  const workspace = resolvedConfig.currentWorkspaceId
    ? resolvedConfig.workspaces.find((item) => item.id === resolvedConfig.currentWorkspaceId) ?? null
    : null;

  if (!workspace) {
    clearWorkspaceWatcher();
    return;
  }

  const aw = mainState.activeWorkspaceWatcher;
  if (aw && aw.workspaceId === workspace.id && aw.workspacePath === workspace.path) {
    return;
  }

  await startWorkspaceWatcher(workspace);
}

/** After load/new conversation, push tree + state summary to Python for the active session. */
export async function syncConversationWorkspaceContext(conv: ConversationFile): Promise<void> {
  mainState.activeConversationWorkspaceId = conv.workspaceId;

  if (conv.workspaceId) {
    const config = await loadConfig();
    const workspace = config.workspaces.find((item) => item.id === conv.workspaceId);
    if (workspace) {
      const aw = mainState.activeWorkspaceWatcher;
      const stagingPath = getWorkspaceStagingDir();
      syncFs.mkdirSync(stagingPath, { recursive: true });
      const tree =
        aw?.workspaceId === workspace.id
          ? aw.lastTree || (await buildWatchedContextSnapshot(workspace.path, stagingPath))
          : await buildWatchedContextSnapshot(workspace.path, stagingPath);
      await syncWorkspaceContextToPython(conv.id, workspace.path, tree, { workspaceId: workspace.id });
      return;
    }
  }

  await syncWorkspaceContextToPython(conv.id, '', '');
}
