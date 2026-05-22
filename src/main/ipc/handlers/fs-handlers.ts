import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path = require('path');
import { assertTrustedAppRenderer, assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { mainState } from '../../state';
import { loadConfig } from '../../config/load-save';
import {
  WORKSPACE_CONTEXT_MAX_DEPTH,
  WORKSPACE_CONTEXT_MAX_ENTRIES,
} from '../../constants';
import { assertRegisteredWorkspaceDirectory } from '../../utils/assert-registered-workspace-dir';
import { buildWorkspaceTree } from '../../workspace/context-tree';
import { loadWorkspaceIgnoreRules } from '../../workspace/ignore-rules';

/**
 * Native folder picker, shallow listing, and recursive tree text for workspace UI.
 */
export function registerFsIpc(): void {
  ipcMain.handle('open-directory-dialog', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    const parent =
      mainState.settingsWindow && !mainState.settingsWindow.isDestroyed() && event.sender === mainState.settingsWindow.webContents
        ? mainState.settingsWindow
        : mainState.mainWindow;
    if (!parent || parent.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(parent, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('read-directory', async (event, dirPath: string) => {
    try {
      assertTrustedMainRenderer(event);
      const safeDir = await assertRegisteredWorkspaceDirectory(dirPath);
      const entries = await fs.readdir(safeDir, { withFileTypes: true });
      const items = entries.map((e) => ({
        name: e.name,
        path: path.join(safeDir, e.name),
        isDirectory: e.isDirectory(),
      }));
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return items;
    } catch {
      return [];
    }
  });

  ipcMain.handle('read-directory-recursive', async (event, dirPath: string) => {
    try {
      assertTrustedMainRenderer(event);
      const safeDir = await assertRegisteredWorkspaceDirectory(dirPath);
      const config = await loadConfig();
      const exposeAllWorkspaceFiles = !!(config.workspaceTools.exposeAllWorkspaceFiles ?? false);
      const ignoreRules = exposeAllWorkspaceFiles ? [] : await loadWorkspaceIgnoreRules(safeDir);
      return await buildWorkspaceTree(safeDir, '', 0, {
        rootPath: safeDir,
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
