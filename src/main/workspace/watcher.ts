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
import { pushWorkspaceFilesChangedToRenderer } from './emit-files-changed';
import { buildWorkspaceTree } from './context-tree';
import { loadWorkspaceIgnoreRules, normalizeContextPath, shouldIgnoreWorkspaceEntry } from './ignore-rules';
import type { WorkspaceWatcherState } from './watcher-state';
import type { WorkspaceChangeKind, WorkspaceContextSyncExtras } from '../../shared';

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

    const tree = await buildWatchedContextSnapshot(
      watcherState.workspacePath,
      watcherState.stagingPath,
      watcherState.exposeAllWorkspaceFiles,
    );
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
        const contextChanges =
          changePayload && (changePayload.paths.length > 0 || changePayload.kinds.length > 0)
            ? filterChangePayloadForContextSync(
                watcherState.workspacePath,
                changePayload,
                watcherState.ignoreRules,
                watcherState.exposeAllWorkspaceFiles,
              )
            : { paths: [] as string[], kinds: [] as WorkspaceChangeKind[] };
        await syncWorkspaceContextToPython(
          mainState.activeConversationId,
          watcherState.workspacePath,
          tree,
          workspaceContextSyncExtras(
            mainState.activeConversationId,
            watcherState.workspaceId,
            watcherState.workspacePath,
            {
              workspaceFileChanges:
                contextChanges.paths.length > 0 || contextChanges.kinds.length > 0
                  ? { paths: contextChanges.paths, kinds: contextChanges.kinds }
                  : undefined,
            },
          ),
        );
      } catch (err) {
        console.error('Failed to sync watched workspace context:', err);
      }
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
    const paths = Array.from(watcherState.pendingChanges.keys()).sort();
    const kinds = paths.map((p) => watcherState.pendingChanges.get(p) ?? 'unknown');
    watcherState.pendingChanges.clear();
    const changePayload: WorkspaceFilesChangedPayload = {
      workspaceId: watcherState.workspaceId,
      workspacePath: watcherState.workspacePath,
      paths,
      kinds,
    };
    // Sidebar refresh must not wait on (or be dropped by) LLM context rebuild during heavy builds.
    pushWorkspaceFilesChangedToRenderer(changePayload);
    void syncWatchedWorkspaceTree(watcherState, changePayload);
  }, WORKSPACE_WATCH_DEBOUNCE_MS);
}

function resolveWatchChangeKind(
  eventType: string,
  watchRootPath: string,
  relativePath: string,
): WorkspaceChangeKind {
  if (eventType === 'change') {
    return 'updated';
  }
  if (eventType !== 'rename') {
    return 'unknown';
  }

  const normalizedRelative = relativePath ? normalizeContextPath(relativePath) : '';
  if (!normalizedRelative || normalizedRelative === '.') {
    return 'unknown';
  }

  const fullPath = path.join(normalizeContextPath(watchRootPath), normalizedRelative);
  try {
    syncFs.accessSync(fullPath);
    return 'created';
  } catch {
    return 'deleted';
  }
}

function createTreeState(
  rootPath: string,
  ignoreRules: string[],
  exposeAllWorkspaceFiles: boolean,
): WorkspaceContextState {
  return {
    rootPath,
    maxDepth: WORKSPACE_CONTEXT_MAX_DEPTH,
    maxEntries: WORKSPACE_CONTEXT_MAX_ENTRIES,
    entriesWritten: 0,
    truncated: false,
    ignoreRules,
    exposeAllWorkspaceFiles,
  };
}

async function buildWatchedContextSnapshot(
  workspacePath: string,
  stagingPath: string,
  exposeAllWorkspaceFiles: boolean,
): Promise<string> {
  syncFs.mkdirSync(stagingPath, { recursive: true });

  const ignoreRules = exposeAllWorkspaceFiles ? [] : await loadWorkspaceIgnoreRules(workspacePath);
  const workspaceTree = await buildWorkspaceTree(
    workspacePath,
    '',
    0,
    createTreeState(workspacePath, ignoreRules, exposeAllWorkspaceFiles),
  );
  const stagingTree = await buildWorkspaceTree(stagingPath, '', 0, createTreeState(stagingPath, [], false));

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

/** Whether a path belongs in the LLM workspace context tree (not the sidebar file tree). */
function shouldIncludeWorkspacePathInContextSync(
  workspacePath: string,
  relativePath: string,
  ignoreRules: string[],
  exposeAllWorkspaceFiles: boolean,
): boolean {
  if (exposeAllWorkspaceFiles) {
    return true;
  }

  const normalizedRelativePath = normalizeContextPath(relativePath).replace(/^\/+/, '');
  if (!normalizedRelativePath || normalizedRelativePath === '.') {
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

function filterChangePayloadForContextSync(
  workspacePath: string,
  payload: WorkspaceFilesChangedPayload,
  ignoreRules: string[],
  exposeAllWorkspaceFiles: boolean,
): { paths: string[]; kinds: WorkspaceChangeKind[] } {
  const paths: string[] = [];
  const kinds: WorkspaceChangeKind[] = [];
  for (let i = 0; i < payload.paths.length; i++) {
    const p = payload.paths[i] ?? '';
    if (p.startsWith('[staging] ')) {
      paths.push(p);
      kinds.push(payload.kinds[i] ?? 'unknown');
      continue;
    }
    if (shouldIncludeWorkspacePathInContextSync(workspacePath, p, ignoreRules, exposeAllWorkspaceFiles)) {
      paths.push(p);
      kinds.push(payload.kinds[i] ?? 'unknown');
    }
  }
  return { paths, kinds };
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
      const changeKind = resolveWatchChangeKind(eventType, rootPath, relativePath);
      aw.pendingChanges.set(formatWatchedPath(source, relativePath), changeKind);
      queueWorkspaceWatcherSync(aw);
    },
  );
}

/** Rebuild workspace tree context when Settings → Tools changes file visibility. */
export async function applyWorkspaceExposeAllFromConfig(config: import('../../shared').AppConfig): Promise<void> {
  const aw = mainState.activeWorkspaceWatcher;
  if (!aw) {
    return;
  }
  const exposeAll = !!(config.workspaceTools.exposeAllWorkspaceFiles ?? false);
  if (aw.exposeAllWorkspaceFiles === exposeAll) {
    return;
  }
  aw.exposeAllWorkspaceFiles = exposeAll;
  if (!exposeAll) {
    try {
      aw.ignoreRules = await loadWorkspaceIgnoreRules(aw.workspacePath);
    } catch {
      aw.ignoreRules = [];
    }
  }
  void syncWatchedWorkspaceTree(aw);
}

export async function startWorkspaceWatcher(workspace: Workspace): Promise<void> {
  clearWorkspaceWatcher();

  const stagingPath = getWorkspaceStagingDir();
  syncFs.mkdirSync(stagingPath, { recursive: true });

  const config = await loadConfig();
  const exposeAllWorkspaceFiles = !!(config.workspaceTools.exposeAllWorkspaceFiles ?? false);

  let ignoreRules: string[];
  try {
    ignoreRules = exposeAllWorkspaceFiles ? [] : await loadWorkspaceIgnoreRules(workspace.path);
  } catch {
    ignoreRules = [];
  }

  try {
    const watcherState: WorkspaceWatcherState = {
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      stagingPath,
      ignoreRules,
      exposeAllWorkspaceFiles,
      watchers: [],
      debounceTimer: null,
      pendingChanges: new Map(),
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
function workspaceContextSyncExtras(
  sessionId: string,
  workspaceId: string,
  workspacePath: string,
  partial?: Omit<WorkspaceContextSyncExtras, 'skipEnvBootstrap'>,
): WorkspaceContextSyncExtras {
  const prev = mainState.sessionWorkspaceContextSync.get(sessionId);
  const sameWorkspace =
    prev !== undefined &&
    prev.workspaceId === workspaceId &&
    prev.workspacePath === workspacePath;
  mainState.sessionWorkspaceContextSync.set(sessionId, { workspaceId, workspacePath });
  return {
    ...partial,
    workspaceId,
    ...(sameWorkspace ? { skipEnvBootstrap: true } : {}),
  };
}

export async function syncConversationWorkspaceContext(conv: ConversationFile): Promise<void> {
  mainState.activeConversationWorkspaceId = conv.workspaceId;

  if (conv.workspaceId) {
    const config = await loadConfig();
    const workspace = config.workspaces.find((item) => item.id === conv.workspaceId);
    if (workspace) {
      const aw = mainState.activeWorkspaceWatcher;
      const stagingPath = getWorkspaceStagingDir();
      syncFs.mkdirSync(stagingPath, { recursive: true });
      const exposeAll = !!(config.workspaceTools.exposeAllWorkspaceFiles ?? false);
      const tree =
        aw?.workspaceId === workspace.id
          ? aw.lastTree ||
            (await buildWatchedContextSnapshot(workspace.path, stagingPath, aw.exposeAllWorkspaceFiles))
          : await buildWatchedContextSnapshot(workspace.path, stagingPath, exposeAll);
      await syncWorkspaceContextToPython(
        conv.id,
        workspace.path,
        tree,
        workspaceContextSyncExtras(conv.id, workspace.id, workspace.path),
      );
      return;
    }
  }

  mainState.sessionWorkspaceContextSync.delete(conv.id);
  await syncWorkspaceContextToPython(conv.id, '', '');
}
