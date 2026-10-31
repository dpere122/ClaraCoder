import { BrowserWindow } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { resolveAppIconPath } from '../utils/app-icon';
import {
  framelessWindowShapeOptions,
  hardenBrowserWindow,
  secureWebPreferences,
} from '../utils/harden-browser-window';
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
 * Non-modal Updates window (`#/updater`): release list from GitHub, release notes, and
 * update / downgrade / reinstall of a verified installer.
 */
export function createUpdaterWindow(): void {
  const mainWindow = mainState.mainWindow;

  if (mainState.updaterWindow && !mainState.updaterWindow.isDestroyed()) {
    mainState.updaterWindow.focus();
    return;
  }

  const icon = resolveAppIconPath();
  mainState.updaterWindow = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 700,
    minHeight: 440,
    ...(mainWindow && !mainWindow.isDestroyed() ? settingsWindowParentOptions(mainWindow) : {}),
    frame: false,
    ...framelessWindowShapeOptions(),
    resizable: true,
    maximizable: true,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Clara Coder — Updates',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preloadPath()),
  });

  const uw = mainState.updaterWindow;
  hardenBrowserWindow(uw);
  uw.removeMenu();
  attachBrowserWindowRevealFallbacks(uw);

  if (DEV_SERVER_URL) {
    uw.loadURL(`${DEV_SERVER_URL}/#/updater`);
  } else {
    uw.loadFile(rendererIndexHtml(), { hash: '/updater' });
  }

  uw.on('closed', () => {
    mainState.updaterWindow = null;
  });
}

export function closeUpdaterWindow(): void {
  const uw = mainState.updaterWindow;
  if (uw && !uw.isDestroyed()) {
    uw.close();
  }
}
