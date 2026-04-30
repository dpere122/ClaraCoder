import { BrowserWindow } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { buildMenu } from '../menu/application-menu';
import { resolveAppIconPath } from '../utils/app-icon';

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
  const icon = resolveAppIconPath();
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    frame: false,
    title: 'Clara Coder',
    ...(icon ? { icon } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath(),
    },
  });
  mainState.mainWindow = win;

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
