import { BrowserWindow } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { buildMenu } from '../menu/application-menu';

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
  mainState.mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath(),
    },
  });

  if (DEV_SERVER_URL) {
    mainState.mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainState.mainWindow.loadFile(rendererIndexHtml());
  }

  buildMenu();
}
