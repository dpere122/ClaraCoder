import { BrowserWindow } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { resolveAppIconPath } from '../utils/app-icon';
import { hardenBrowserWindow, secureWebPreferences } from '../utils/harden-browser-window';
import {
  attachBrowserWindowRevealFallbacks,
  settingsWindowParentOptions,
} from '../utils/reveal-browser-window';

function preloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'preload.js');
}

function rendererIndexHtml(): string {
  return path.join(__dirname, '..', '..', 'renderer', 'browser', 'index.html');
}

/**
 * Non-modal, resizable settings surface (Angular `#/settings`). Reuses preload; notifies renderer
 * when shown/hidden. The main window stays interactive and undimmed while this is open.
 */
export function createSettingsWindow(): void {
  const mainWindow = mainState.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const notifyVisibility = (isOpen: boolean): void => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('settings-window-visibility-changed', isOpen);
  };

  if (mainState.settingsWindow) {
    notifyVisibility(true);
    mainState.settingsWindow.focus();
    return;
  }

  const icon = resolveAppIconPath();
  mainState.settingsWindow = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    ...settingsWindowParentOptions(mainWindow),
    frame: false,
    resizable: true,
    maximizable: true,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Clara Coder — Settings',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preloadPath()),
  });

  const sw = mainState.settingsWindow;
  hardenBrowserWindow(sw);
  sw.removeMenu();
  attachBrowserWindowRevealFallbacks(sw);
  notifyVisibility(true);

  if (DEV_SERVER_URL) {
    sw.loadURL(`${DEV_SERVER_URL}/#/settings`);
  } else {
    sw.loadFile(rendererIndexHtml(), { hash: '/settings' });
  }

  sw.on('closed', () => {
    notifyVisibility(false);
    mainState.settingsWindow = null;
  });
}
