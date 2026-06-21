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
  let windowRevealed = false;
  const revealMainWindow = (): void => {
    if (windowRevealed || win.isDestroyed()) return;
    windowRevealed = true;
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  };
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    frame: false,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Clara Coder',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preload),
  });
  mainState.mainWindow = win;
  hardenBrowserWindow(win);
  registerSelectableTextContextMenu(win);
  // Avoid a blank flash before first paint; fall back when ready-to-show is skipped (Linux Wayland + disable-gpu).
  win.once('ready-to-show', () => {
    revealMainWindow();
    if (DEV_SERVER_URL) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        revealMainWindow();
      }
    }, 500);
  });
  setTimeout(revealMainWindow, 3000);

  win.webContents.on('preload-error', (_event, failedPreload, error) => {
    console.error('[Main] Preload failed:', failedPreload, error);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[Main] Renderer failed to load:', code, description, url);
    revealMainWindow();
  });
  if (DEV_SERVER_URL) {
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) {
        console.error(`[Renderer] ${message} (${sourceId}:${line})`);
      }
    });
  }
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
