import path = require('path');

import type { WorkspaceChangeKind } from '../../shared';
import { loadConfig } from '../config/load-save';
import { mainState } from '../state';
import { isSameWorkspaceRootPath } from '../utils/workspace-entry-transfer';

/** Push a workspace-files-changed event to the renderer (works even when the FS watcher is inactive). */
export async function emitWorkspaceFilesChanged(
  workspaceRoot: string,
  absolutePath: string,
  kind: WorkspaceChangeKind,
  previousAbsolutePath?: string,
): Promise<void> {
  const root = workspaceRoot.trim();
  if (!root) {
    return;
  }

  let workspaceId: string;
  let workspacePath: string;

  const watcher = mainState.activeWorkspaceWatcher;
  if (watcher && isSameWorkspaceRootPath(root, watcher.workspacePath)) {
    workspaceId = watcher.workspaceId;
    workspacePath = watcher.workspacePath;
  } else {
    const config = await loadConfig();
    const ws = config.workspaces.find((w) => isSameWorkspaceRootPath(root, w.path));
    if (!ws) {
      return;
    }
    workspaceId = ws.id;
    workspacePath = ws.path;
  }

  const rel = path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
  const relPath = rel && rel !== '' ? rel : '.';
  let previousPaths: string[] | undefined;
  if (previousAbsolutePath?.trim()) {
    const prevRel = path.relative(workspacePath, previousAbsolutePath).replace(/\\/g, '/');
    previousPaths = [prevRel && prevRel !== '' ? prevRel : '.'];
  }

  mainState.mainWindow?.webContents.send('workspace-files-changed', {
    workspaceId,
    workspacePath,
    paths: [relPath],
    kinds: [kind],
    ...(previousPaths ? { previousPaths } : {}),
  });
}
