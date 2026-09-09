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
 * Non-modal Dependencies manager (`#/dependencies`). Theme + install UI for
 * Python runtime, llama-server, Java LSP, Kokoro, and Whisper.
 */
export function createDependenciesWindow(): void {
  const mainWindow = mainState.mainWindow;

  if (mainState.dependenciesWindow && !mainState.dependenciesWindow.isDestroyed()) {
    mainState.dependenciesWindow.focus();
    return;
  }

  const icon = resolveAppIconPath();
  mainState.dependenciesWindow = new BrowserWindow({
    width: 860,
    height: 600,
    minWidth: 680,
    minHeight: 480,
    ...(mainWindow && !mainWindow.isDestroyed() ? settingsWindowParentOptions(mainWindow) : {}),
    frame: false,
    ...framelessWindowShapeOptions(),
    resizable: true,
    maximizable: true,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Clara Coder — Dependencies',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preloadPath()),
  });

  const dw = mainState.dependenciesWindow;
  hardenBrowserWindow(dw);
  dw.removeMenu();
  attachBrowserWindowRevealFallbacks(dw);

  if (DEV_SERVER_URL) {
    dw.loadURL(`${DEV_SERVER_URL}/#/dependencies`);
  } else {
    dw.loadFile(rendererIndexHtml(), { hash: '/dependencies' });
  }

  dw.on('closed', () => {
    mainState.dependenciesWindow = null;
  });
}

export function closeDependenciesWindow(): void {
  const dw = mainState.dependenciesWindow;
  if (dw && !dw.isDestroyed()) {
    dw.close();
  }
}
