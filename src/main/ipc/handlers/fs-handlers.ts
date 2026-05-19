import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path = require('path');
import { mainState } from '../../state';
import { loadConfig } from '../../config/load-save';
import {
  WORKSPACE_CONTEXT_MAX_DEPTH,
  WORKSPACE_CONTEXT_MAX_ENTRIES,
} from '../../constants';
import { buildWorkspaceTree } from '../../workspace/context-tree';
import { loadWorkspaceIgnoreRules } from '../../workspace/ignore-rules';

/**
 * Native folder picker, shallow listing, and recursive tree text for workspace UI.
 */
export function registerFsIpc(): void {
  ipcMain.handle('open-directory-dialog', async () => {
    const mw = mainState.mainWindow;
    if (!mw) return null;
    const result = await dialog.showOpenDialog(mw, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('read-directory', async (_event, dirPath: string) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const items = entries.map((e) => ({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
    }));
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  });

  ipcMain.handle('read-directory-recursive', async (_event, dirPath: string) => {
    try {
      const config = await loadConfig();
      const exposeAllWorkspaceFiles = !!(config.workspaceTools.exposeAllWorkspaceFiles ?? false);
      const ignoreRules = exposeAllWorkspaceFiles ? [] : await loadWorkspaceIgnoreRules(dirPath);
      return await buildWorkspaceTree(dirPath, '', 0, {
        rootPath: dirPath,
        maxDepth: WORKSPACE_CONTEXT_MAX_DEPTH,
        maxEntries: WORKSPACE_CONTEXT_MAX_ENTRIES,
        entriesWritten: 0,
        truncated: false,
        ignoreRules,
        exposeAllWorkspaceFiles,
      });
    } catch {
      return '';
    }
  });
}
