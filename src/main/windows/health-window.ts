import { BrowserWindow, ipcMain } from 'electron';
import path = require('path');
import { mkdirSync } from 'fs';
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { getLogsDir } from '../paths';
import { resolveAppIconPath } from '../utils/app-icon';
import {
  framelessWindowShapeOptions,
  hardenBrowserWindow,
  secureWebPreferences,
} from '../utils/harden-browser-window';
import {
  attachBrowserWindowRevealFallbacks,
  returnFocusToParentOnClose,
  settingsWindowParentOptions,
} from '../utils/reveal-browser-window';

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
 * Non-modal health monitor (`#/health`). Does not dim the main window, but is parented to it
 * (like Settings and Dependencies) so it stays layered above the main window.
 */
export function createHealthWindow(): void {
  ensureLogsDir();

  if (mainState.healthWindow && !mainState.healthWindow.isDestroyed()) {
    mainState.healthWindow.focus();
    return;
  }

  const mainWindow = mainState.mainWindow;
  const icon = resolveAppIconPath();
  mainState.healthWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    ...(mainWindow && !mainWindow.isDestroyed() ? settingsWindowParentOptions(mainWindow) : {}),
    frame: false,
    ...framelessWindowShapeOptions(),
    resizable: true,
    maximizable: true,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Clara Coder — Health',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preloadPath()),
  });

  const hw = mainState.healthWindow;
  hardenBrowserWindow(hw);
  hw.removeMenu();
  attachBrowserWindowRevealFallbacks(hw);
  returnFocusToParentOnClose(hw, mainWindow);

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
