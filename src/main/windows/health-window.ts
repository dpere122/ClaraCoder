import { BrowserWindow, ipcMain } from 'electron';
import path = require('path');
import { mkdirSync } from 'fs';
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { getLogsDir } from '../paths';

function preloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'preload.js');
}

function rendererIndexHtml(): string {
  return path.join(__dirname, '..', '..', 'renderer', 'browser', 'index.html');
}

function ensureLogsDir(): void {
  mkdirSync(getLogsDir(), { recursive: true });
}

/**
 * Non-modal health monitor (`#/health`). Does not dim the main window.
 */
export function createHealthWindow(): void {
  ensureLogsDir();

  if (mainState.healthWindow && !mainState.healthWindow.isDestroyed()) {
    mainState.healthWindow.focus();
    return;
  }

  mainState.healthWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    frame: false,
    resizable: true,
    maximizable: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath(),
    },
  });

  const hw = mainState.healthWindow;
  hw.removeMenu();
  hw.once('ready-to-show', () => {
    hw.show();
  });

  if (DEV_SERVER_URL) {
    hw.loadURL(`${DEV_SERVER_URL}/#/health`);
  } else {
    hw.loadFile(rendererIndexHtml(), { hash: '/health' });
  }

  hw.on('closed', () => {
    mainState.healthWindow = null;
  });
}

export function closeHealthWindow(): void {
  const hw = mainState.healthWindow;
  if (hw && !hw.isDestroyed()) {
    hw.close();
  }
}

export function registerHealthWindowIpc(): void {
  ipcMain.on('open-health-window', () => {
    createHealthWindow();
  });
  ipcMain.on('close-health-window', () => {
    closeHealthWindow();
  });
}
