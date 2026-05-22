import { BrowserWindow } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { buildMenu } from '../menu/application-menu';
import { resolveAppIconPath } from '../utils/app-icon';
import { hardenBrowserWindow, secureWebPreferences } from '../utils/harden-browser-window';
import { registerSelectableTextContextMenu } from '../utils/register-selectable-text-context-menu';

/** Preload bundle lives next to main output: `dist/preload/preload.js`. */
function preloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'preload.js');
}

/** Packaged renderer entry: `dist/renderer/browser/index.html`. */
function rendererIndexHtml(): string {
  return path.join(__dirname, '..', '..', 'renderer', 'browser', 'index.html');
}

/**
 * Creates the primary BrowserWindow (dev server URL or static Angular build).
 */
export function createMainWindow(): void {
  const existing = mainState.mainWindow;
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const icon = resolveAppIconPath();
  const preload = preloadPath();
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    frame: false,
    title: 'Clara Coder',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preload),
  });
  mainState.mainWindow = win;
  hardenBrowserWindow(win);
  registerSelectableTextContextMenu(win);

  win.webContents.on('preload-error', (_event, failedPreload, error) => {
    console.error('[Main] Preload failed:', failedPreload, error);
  });
  if (DEV_SERVER_URL) {
    console.log('[Main] Preload script:', preload);
  }

  const broadcastMaximized = (): void => {
    win.webContents.send('window-maximized-changed', win.isMaximized());
  };
  win.on('maximize', broadcastMaximized);
  win.on('unmaximize', broadcastMaximized);
  win.webContents.on('did-finish-load', broadcastMaximized);

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(rendererIndexHtml());
  }

  buildMenu();
}
