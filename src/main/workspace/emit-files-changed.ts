import path = require('path');

import type { WorkspaceChangeKind, WorkspaceFilesChangedPayload } from '../../shared';
import { loadConfig } from '../config/load-save';
import { mainState } from '../state';
import { isSameWorkspaceRootPath } from '../utils/workspace-entry-transfer';
import { isAlwaysIgnoredWorkspaceEntry } from './ignore-rules';

function isAlwaysIgnoredWatchPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized === '.') {
    return false;
  }
  // Staging-prefixed paths are not workspace secrets in the same sense; still check basename.
  const withoutStaging = normalized.startsWith('[staging] ')
    ? normalized.slice('[staging] '.length)
    : normalized;
  const segments = withoutStaging.split('/').filter(Boolean);
  const entryName = segments[segments.length - 1] || withoutStaging;
  return isAlwaysIgnoredWorkspaceEntry(entryName, withoutStaging);
}

function omitAlwaysIgnoredFromPayload(payload: WorkspaceFilesChangedPayload): WorkspaceFilesChangedPayload {
  const paths: string[] = [];
  const kinds: WorkspaceChangeKind[] = [];
  const previousPaths: string[] = [];
  const hasPrevious = Array.isArray(payload.previousPaths);

  for (let i = 0; i < payload.paths.length; i++) {
    const p = payload.paths[i] ?? '';
    const prev = hasPrevious ? (payload.previousPaths?.[i] ?? '') : '';
    // Drop if current OR previous path is denylisted (rename .env→config.txt must not leak .env).
    if (isAlwaysIgnoredWatchPath(p) || (prev !== '' && isAlwaysIgnoredWatchPath(prev))) {
      continue;
    }
    paths.push(p);
    kinds.push(payload.kinds[i] ?? 'unknown');
    if (hasPrevious) {
      previousPaths.push(prev);
    }
  }

  if (paths.length === payload.paths.length) {
    return payload;
  }

  return {
    ...payload,
    paths,
    kinds,
    ...(hasPrevious ? { previousPaths } : {}),
  };
}

async function resolveWorkspaceForDiskRoot(
  workspaceRoot: string,
): Promise<{ workspaceId: string; workspacePath: string } | null> {
  const root = workspaceRoot.trim();
  if (!root) {
    return null;
  }

  const watcher = mainState.activeWorkspaceWatcher;
  if (watcher && isSameWorkspaceRootPath(root, watcher.workspacePath)) {
    return { workspaceId: watcher.workspaceId, workspacePath: watcher.workspacePath };
  }

  const config = await loadConfig();
  const ws = config.workspaces.find((w) => isSameWorkspaceRootPath(root, w.path));
  if (!ws) {
    return null;
  }
  return { workspaceId: ws.id, workspacePath: ws.path };
}

/** Push a payload to the renderer sidebar file tree (never blocked on LLM context rebuild). */
export function pushWorkspaceFilesChangedToRenderer(payload: WorkspaceFilesChangedPayload): void {
  const win = mainState.mainWindow;
  if (!win || win.isDestroyed()) {
    return;
  }
  const safePayload = omitAlwaysIgnoredFromPayload(payload);
  if (safePayload.paths.length === 0 && payload.paths.length > 0) {
    // Entire batch was denylisted — do not leak secret paths over IPC.
    return;
  }
  try {
    win.webContents.send('workspace-files-changed', safePayload);
  } catch {
    /* window tearing down */
  }
}

/** Ask the renderer to resync the visible file tree from disk (e.g. after terminal build output). */
export async function notifyWorkspaceTreeRefresh(workspaceRoot: string): Promise<void> {
  const resolved = await resolveWorkspaceForDiskRoot(workspaceRoot);
  if (!resolved) {
    return;
  }
  pushWorkspaceFilesChangedToRenderer({
    workspaceId: resolved.workspaceId,
    workspacePath: resolved.workspacePath,
    paths: ['.'],
    kinds: ['unknown'],
  });
}

/** Push a workspace-files-changed event to the renderer (works even when the FS watcher is inactive). */
export async function emitWorkspaceFilesChanged(
  workspaceRoot: string,
  absolutePath: string,
  kind: WorkspaceChangeKind,
  previousAbsolutePath?: string,
): Promise<void> {
  const resolved = await resolveWorkspaceForDiskRoot(workspaceRoot);
  if (!resolved) {
    return;
  }
  const { workspaceId, workspacePath } = resolved;

  const rel = path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
  const relPath = rel && rel !== '' ? rel : '.';
  let previousPaths: string[] | undefined;
  if (previousAbsolutePath?.trim()) {
    const prevRel = path.relative(workspacePath, previousAbsolutePath).replace(/\\/g, '/');
    previousPaths = [prevRel && prevRel !== '' ? prevRel : '.'];
  }

  pushWorkspaceFilesChangedToRenderer({
    workspaceId,
    workspacePath,
    paths: [relPath],
    kinds: [kind],
    ...(previousPaths ? { previousPaths } : {}),
  });
}
