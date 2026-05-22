import { BrowserWindow } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { resolveAppIconPath } from '../utils/app-icon';
import { hardenBrowserWindow, secureWebPreferences } from '../utils/harden-browser-window';

function preloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'preload.js');
}

function rendererIndexHtml(): string {
  return path.join(__dirname, '..', '..', 'renderer', 'browser', 'index.html');
}

/**
 * Modal settings surface (Angular `#/settings`). Reuses preload; notifies renderer when shown/hidden.
 */
export function createSettingsWindow(): void {
  const mainWindow = mainState.mainWindow;
  if (!mainWindow) return;

  if (mainState.settingsWindow) {
    mainWindow.webContents.send('settings-window-visibility-changed', true);
    mainState.settingsWindow.focus();
    return;
  }

  const icon = resolveAppIconPath();
  mainState.settingsWindow = new BrowserWindow({
    width: 1440,
    height: 800,
    parent: mainWindow,
    modal: true,
    frame: false,
    resizable: false,
    maximizable: false,
    show: false,
    title: 'Clara Coder — Settings',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preloadPath()),
  });

  const sw = mainState.settingsWindow;
  hardenBrowserWindow(sw);
  sw.removeMenu();
  sw.once('ready-to-show', () => {
    sw.show();
  });
  mainWindow.webContents.send('settings-window-visibility-changed', true);

  if (DEV_SERVER_URL) {
    sw.loadURL(`${DEV_SERVER_URL}/#/settings`);
  } else {
    sw.loadFile(rendererIndexHtml(), { hash: '/settings' });
  }

  sw.on('closed', () => {
    mainWindow.webContents.send('settings-window-visibility-changed', false);
    mainState.settingsWindow = null;
  });
}
