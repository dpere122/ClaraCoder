import { BrowserWindow } from 'electron';
import path = require('path');
import { DEV_SERVER_URL } from '../constants';
import { mainState } from '../state';
import { buildMenu } from '../menu/application-menu';
import { resolveAppIconPath } from '../utils/app-icon';
import { isPrimaryEditorFindShortcut } from '../utils/editor-find-shortcut';
import {
  framelessWindowShapeOptions,
  hardenBrowserWindow,
  secureWebPreferences,
} from '../utils/harden-browser-window';
import { attachBrowserWindowRevealFallbacks } from '../utils/reveal-browser-window';
import { registerSelectableTextContextMenu } from '../utils/register-selectable-text-context-menu';

/** Preload bundle lives next to main output: `dist/preload/preload.js`. */
function preloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'preload.js');
}

/** Known-harmless Chromium / WebAudio noise we do not relay in `npm run dev`. */
function shouldSuppressDevRendererConsole(message: string): boolean {
  return (
    message.includes('ScriptProcessorNode is deprecated') ||
    message.includes("Content Security Policy directive 'frame-ancestors'") ||
    message.includes('Frame latency is negative')
  );
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
    ...framelessWindowShapeOptions(),
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Clara Coder',
    ...(icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preload),
  });
  mainState.mainWindow = win;
  hardenBrowserWindow(win);
  registerSelectableTextContextMenu(win);
  attachBrowserWindowRevealFallbacks(win);
  // Chromium's in-page Find (Ctrl/Cmd+F) is unreliable in frameless Electron on
  // Linux Wayland and races Monaco's own binding. Steal the chord and let the
  // renderer open Monaco's find widget when a file editor is active.
  win.webContents.on('before-input-event', (event, input) => {
    if (!isPrimaryEditorFindShortcut(input)) {
      return;
    }
    event.preventDefault();
    if (!win.isDestroyed()) {
      win.webContents.send('editor-find-requested');
    }
  });

  win.webContents.on('preload-error', (_event, failedPreload, error) => {
    console.error('[Main] Preload failed:', failedPreload, error);
  });
  if (DEV_SERVER_URL) {
    win.webContents.on('console-message', (event) => {
      // Use Event params only — positional console-message args are deprecated in Electron.
      if (event.level !== 'warning' && event.level !== 'error') {
        return;
      }
      if (shouldSuppressDevRendererConsole(event.message)) {
        return;
      }
      console.error(`[Renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
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
  win.on('closed', () => {
    if (mainState.mainWindow === win) {
      mainState.mainWindow = null;
    }
  });

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(rendererIndexHtml());
  }

  buildMenu();
}
