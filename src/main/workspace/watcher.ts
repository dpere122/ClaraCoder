import path = require('path');
const syncFs = require('fs');
import type { ConversationFile, Workspace, WorkspaceFilesChangedPayload } from '../../shared';
import {
  WORKSPACE_CHANGE_HISTORY_LIMIT,
  WORKSPACE_CONTEXT_IGNORED_NAMES,
  WORKSPACE_CONTEXT_IGNORED_SUFFIXES,
  WORKSPACE_WATCH_DEBOUNCE_MS,
} from '../constants';
import { mainState } from '../state';
import { loadConfig } from '../config/load-save';
import { syncWorkspaceContextToPython } from '../python/workspace-sync';
import { buildWorkspaceTree, formatWorkspaceStateSummary } from './context-tree';
import { loadWorkspaceIgnoreRules, normalizeContextPath, shouldIgnoreWorkspaceEntry } from './ignore-rules';
import type { WorkspaceWatcherState } from './watcher-state';
import type { WorkspaceChangeKind } from '../../shared';

export type { WorkspaceWatcherState };

export function clearWorkspaceWatcher(): void {
  const w = mainState.activeWorkspaceWatcher;
  if (!w) return;
  if (w.debounceTimer) {
    clearTimeout(w.debounceTimer);
  }
  w.watcher.close();
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
    if (changePayload?.paths.some((p) => isRootGitignoreWatchPath(p))) {
      watcherState.ignoreRules = await loadWorkspaceIgnoreRules(watcherState.workspacePath);
    }

    const tree = await buildWorkspaceTree(watcherState.workspacePath);
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

    const workspaceState = formatWorkspaceStateSummary(watcherState.lastSyncedAt, watcherState.recentChanges);

    if (
      mainState.activeConversationId &&
      mainState.activeConversationWorkspaceId === watcherState.workspaceId
    ) {
      try {
        await syncWorkspaceContextToPython(
          mainState.activeConversationId,
          watcherState.workspacePath,
          tree,
          workspaceState,
        );
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

export async function startWorkspaceWatcher(workspace: Workspace): Promise<void> {
  clearWorkspaceWatcher();

  let ignoreRules: string[];
  try {
    ignoreRules = await loadWorkspaceIgnoreRules(workspace.path);
  } catch {
    ignoreRules = [];
  }

  try {
    const watcher = syncFs.watch(
      workspace.path,
      { recursive: true },
      (eventType: string, filename: string | Buffer | undefined) => {
        const aw = mainState.activeWorkspaceWatcher;
        if (!aw || aw.workspaceId !== workspace.id) {
          return;
        }

        const relativePath = filename ? filename.toString() : '';
        if (relativePath && !shouldProcessWorkspaceWatchPath(workspace.path, relativePath, aw.ignoreRules)) {
          return;
        }

        const normalizedRelativePath = relativePath ? normalizeContextPath(relativePath) : '.';
        const changeKind = getWorkspaceChangeKind(eventType);
        aw.pendingPaths.add(normalizedRelativePath);
        aw.pendingKinds.add(changeKind);
        queueWorkspaceWatcherSync(aw);
      },
    );

    watcher.on('error', (err: Error) => {
      console.error('Workspace watcher error:', err);
    });

    mainState.activeWorkspaceWatcher = {
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      ignoreRules,
      watcher,
      debounceTimer: null,
      pendingPaths: new Set(),
      pendingKinds: new Set(),
      syncVersion: 0,
      lastTree: '',
      lastSyncedAt: null,
      recentChanges: [],
    };

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
      const tree =
        aw?.workspaceId === workspace.id
          ? aw.lastTree || (await buildWorkspaceTree(workspace.path))
          : await buildWorkspaceTree(workspace.path);
      const workspaceState =
        aw?.workspaceId === workspace.id
          ? formatWorkspaceStateSummary(aw.lastSyncedAt, aw.recentChanges)
          : formatWorkspaceStateSummary(null, []);
      await syncWorkspaceContextToPython(conv.id, workspace.path, tree, workspaceState);
      return;
    }
  }

  await syncWorkspaceContextToPython(conv.id, '', '', '');
}
