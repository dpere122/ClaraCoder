import { Menu, shell } from 'electron';
import type Electron from 'electron';
import { createSettingsWindow, SETTINGS_WINDOW_TABS } from '../windows/settings-window';
import { createHealthWindow } from '../windows/health-window';
import { createDependenciesWindow } from '../windows/dependencies-window';

/** Hosts permitted for Documentation / shell.openExternal. */
const ALLOWED_EXTERNAL_HOSTS = new Set(['github.com', 'docs.claraverse.ai']);

/** Pinned Clara docs URL (must pass {@link validateExternalUrl}). */
const DOCUMENTATION_URL = 'https://github.com/dpere122/ClaraCoder';

/**
 * Only http(s) URLs on the small host allowlist may be opened externally.
 * Rejects file:, data:, javascript:, and other schemes.
 */
export function validateExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  if (!validateExternalUrl(url)) {
    console.warn(`[Main] Blocked openExternal for disallowed URL: ${url}`);
    return;
  }
  void shell.openExternal(url);
}

function buildSettingsMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return SETTINGS_WINDOW_TABS.map((tab, index) => ({
    label: tab.label,
    accelerator: index === 0 ? 'CmdOrCtrl+,' : undefined,
    click: () => createSettingsWindow(tab.id),
  }));
}

function buildWindowMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  if (process.platform === 'darwin') {
    return [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }];
  }
  return [{ role: 'minimize' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'close' }];
}

/**
 * Native application menu: Alt fallback on Windows/Linux and keyboard accelerators.
 * Titlebar Settings/Dependencies/Health use themed in-renderer controls instead of Menu.popup.
 */
export function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'Settings', submenu: buildSettingsMenuTemplate() },
    {
      label: 'Dependencies',
      submenu: [{ label: 'Open', click: () => createDependenciesWindow() }],
    },
    {
      label: 'Health',
      submenu: [{ label: 'Open', click: () => createHealthWindow() }],
    },
    { label: 'Window', submenu: buildWindowMenuTemplate() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Opens the docs URL from renderer IPC. */
export function openDocumentation(): void {
  openExternalUrl(DOCUMENTATION_URL);
}
