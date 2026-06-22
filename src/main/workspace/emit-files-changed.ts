import path = require('path');

import type { WorkspaceChangeKind, WorkspaceFilesChangedPayload } from '../../shared';
import { loadConfig } from '../config/load-save';
import { mainState } from '../state';
import { isSameWorkspaceRootPath } from '../utils/workspace-entry-transfer';

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
  mainState.mainWindow?.webContents.send('workspace-files-changed', payload);
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
