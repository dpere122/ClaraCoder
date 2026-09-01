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

/** Keep labels in sync with renderer `SETTINGS_TABS`. */
export const SETTINGS_WINDOW_TABS = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'modelManager', label: 'Model Manager' },
  { id: 'tools', label: 'Tools' },
  { id: 'monaco', label: 'Editor' },
  { id: 'audio', label: 'Audio' },
  { id: 'workspaces', label: 'Workspaces' },
] as const;

export type SettingsWindowTab = (typeof SETTINGS_WINDOW_TABS)[number]['id'];

export function parseSettingsWindowTab(value: unknown): SettingsWindowTab | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return SETTINGS_WINDOW_TABS.some((tab) => tab.id === value) ? (value as SettingsWindowTab) : undefined;
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

function sendSettingsTab(sw: BrowserWindow, tab: SettingsWindowTab): void {
  const send = (): void => {
    if (!sw.isDestroyed()) {
      sw.webContents.send('settings-select-tab', tab);
    }
  };
  if (sw.webContents.isLoading()) {
    sw.webContents.once('did-finish-load', send);
    return;
  }
  send();
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
      sendSettingsTab(mainState.settingsWindow, tab);
    }
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
    notifyVisibility(false);
    mainState.settingsWindow = null;
  });
}
