import { dialog, ipcMain, shell } from 'electron';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import path = require('path');
import { assertTrustedAppRenderer, assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { mainState } from '../../state';
import { loadConfig } from '../../config/load-save';
import {
  WORKSPACE_CONTEXT_MAX_DEPTH,
  WORKSPACE_CONTEXT_MAX_ENTRIES,
} from '../../constants';
import {
  assertRegisteredWorkspaceDirectory,
  assertRegisteredWorkspaceEntry,
} from '../../utils/assert-registered-workspace-dir';
import { buildWorkspaceTree } from '../../workspace/context-tree';
import { loadWorkspaceIgnoreRules } from '../../workspace/ignore-rules';

/** Desktop on Windows/macOS when that folder exists; otherwise the user home directory. */
export function defaultOpenFileDialogPath(): string {
  const home = homedir();
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const desktop = path.join(home, 'Desktop');
    if (existsSync(desktop)) {
      return desktop;
    }
  }
  return home;
}

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

  ipcMain.handle('open-file-dialog', async (event, options?: { filters?: { name: string; extensions: string[] }[] }) => {
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
    const filters =
      Array.isArray(options?.filters) && options.filters.length > 0
        ? options.filters
        : [{ name: 'All files', extensions: ['*'] }];
    const result = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      filters,
      defaultPath: defaultOpenFileDialogPath(),
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

  ipcMain.handle('workspace-path-is-directory', async (event, absolutePath: string) => {
    try {
      assertTrustedMainRenderer(event);
      await assertRegisteredWorkspaceDirectory(absolutePath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('show-workspace-path-in-file-manager', async (event, absolutePath: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { ok: false as const, error: 'Forbidden' };
    }
    try {
      const safePath = await assertRegisteredWorkspaceEntry(absolutePath);
      const stat = await fs.stat(safePath);
      if (stat.isDirectory()) {
        const err = await shell.openPath(safePath);
        if (err) {
          return { ok: false as const, error: err };
        }
        return { ok: true as const };
      }
      shell.showItemInFolder(safePath);
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });
}
