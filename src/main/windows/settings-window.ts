import { BrowserWindow, type WebContents } from 'electron';
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

/**
 * Non-modal, resizable settings surface (Angular `#/settings`). Reuses preload; notifies renderer
 * when shown/hidden. The main window stays interactive and undimmed while this is open.
 * Optional `tab` opens (or switches) a settings category from the titlebar menu.
 */
export function createSettingsWindow(tab?: SettingsWindowTab): void {
  const mainWindow = mainState.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const notifyVisibility = (isOpen: boolean): void => {
    if (mainWindow.isDestroyed()) return;
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
    width: 1680,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    ...settingsWindowParentOptions(mainWindow),
    frame: false,
    ...framelessWindowShapeOptions(),
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
