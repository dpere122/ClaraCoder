import { BrowserWindow, screen, type WebContents } from 'electron';
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
  returnFocusToParentOnClose,
  settingsWindowParentOptions,
} from '../utils/reveal-browser-window';
import { broadcastThemePreview } from '../ipc/handlers/theme-broadcast';
import { isSettingsTab, type SettingsTab as SettingsWindowTab } from '../../shared/settings-tabs';

export { SETTINGS_TAB_ENTRIES as SETTINGS_WINDOW_TABS } from '../../shared/settings-tabs';
export type { SettingsTab as SettingsWindowTab } from '../../shared/settings-tabs';

export function parseSettingsWindowTab(value: unknown): SettingsWindowTab | undefined {
  return isSettingsTab(value) ? value : undefined;
}

function preloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'preload.js');
}

function rendererIndexHtml(): string {
  return path.join(__dirname, '..', '..', 'renderer', 'browser', 'index.html');
}

function settingsHash(tab?: SettingsWindowTab): string {
  return tab ? `/settings?tab=${tab}` : '/settings';
}

let settingsRendererReady = false;
let pendingSettingsTab: SettingsWindowTab | undefined;

export function resetSettingsTabDelivery(): void {
  settingsRendererReady = false;
  pendingSettingsTab = undefined;
}

function sendSettingsTabNow(sw: BrowserWindow, tab: SettingsWindowTab): void {
  if (!sw.isDestroyed()) {
    sw.webContents.send('settings-select-tab', tab);
  }
}

function queueSettingsWindowTab(sw: BrowserWindow, tab: SettingsWindowTab): void {
  pendingSettingsTab = tab;
  if (settingsRendererReady) {
    sendSettingsTabNow(sw, tab);
  }
}

/** Flush a queued tab once SettingsStore has subscribed to `settings-select-tab`. */
export function notifySettingsRendererReady(sender: WebContents): void {
  const sw = mainState.settingsWindow;
  if (!sw || sw.isDestroyed() || sender !== sw.webContents) {
    return;
  }
  settingsRendererReady = true;
  if (pendingSettingsTab) {
    sendSettingsTabNow(sw, pendingSettingsTab);
  }
}

const SETTINGS_WINDOW_WIDTH = 1680;
const SETTINGS_WINDOW_HEIGHT = 980;

/**
 * The Settings window's one size. It cannot be resized, so on a display smaller than the design
 * size it takes the display's work area instead of hanging off the screen.
 */
export function settingsWindowSize(workArea: { width: number; height: number } | null): {
  width: number;
  height: number;
} {
  if (!workArea || workArea.width <= 0 || workArea.height <= 0) {
    return { width: SETTINGS_WINDOW_WIDTH, height: SETTINGS_WINDOW_HEIGHT };
  }
  return {
    width: Math.min(SETTINGS_WINDOW_WIDTH, Math.floor(workArea.width)),
    height: Math.min(SETTINGS_WINDOW_HEIGHT, Math.floor(workArea.height)),
  };
}

/** Work area of the display the main window is on (Settings opens over it); null when unknown. */
function workAreaOf(win: BrowserWindow): { width: number; height: number } | null {
  try {
    return screen.getDisplayMatching(win.getBounds()).workAreaSize;
  } catch {
    return null;
  }
}

/**
 * Non-modal settings surface of a fixed size (Angular `#/settings`). Reuses preload; notifies renderer
 * when shown/hidden. The main window stays interactive and undimmed while this is open.
 * Optional `tab` opens (or switches) a settings category from the titlebar menu.
 */
export function createSettingsWindow(tab?: SettingsWindowTab): void {
  const mainWindow = mainState.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const notifyVisibility = (isOpen: boolean): void => {
    // On quit the main window's webContents can be gone before the window itself.
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('settings-window-visibility-changed', isOpen);
  };

  if (mainState.settingsWindow) {
    notifyVisibility(true);
    if (tab) {
      queueSettingsWindowTab(mainState.settingsWindow, tab);
    }
    mainState.settingsWindow.focus();
    return;
  }

  resetSettingsTabDelivery();

  const icon = resolveAppIconPath();
  mainState.settingsWindow = new BrowserWindow({
    ...settingsWindowSize(workAreaOf(mainWindow)),
    ...settingsWindowParentOptions(mainWindow),
    frame: false,
    ...framelessWindowShapeOptions(),
    resizable: false,
    maximizable: false,
    fullscreenable: false,
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
  returnFocusToParentOnClose(sw, mainWindow);
  notifyVisibility(true);

  const hash = settingsHash(tab);
  if (DEV_SERVER_URL) {
    sw.loadURL(`${DEV_SERVER_URL}/#${hash}`);
  } else {
    sw.loadFile(rendererIndexHtml(), { hash });
  }

  sw.on('closed', () => {
    resetSettingsTabDelivery();
    notifyVisibility(false);
    mainState.settingsWindow = null;
    // The renderer is gone before any Angular teardown can run, so a live theme preview
    // started from Settings → Themes would otherwise stay painted in every other window.
    broadcastThemePreview(null);
  });
}
