import { dialog, Menu, shell } from 'electron';
import type Electron from 'electron';
import { mainState } from '../state';
import { createSettingsWindow } from '../windows/settings-window';
import { createHealthWindow } from '../windows/health-window';
import { createDependenciesWindow } from '../windows/dependencies-window';

/** Hosts permitted for Help → Documentation / shell.openExternal. */
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

function buildFileMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'Settings',
      accelerator: 'CmdOrCtrl+,',
      click: () => createSettingsWindow(),
    },
    {
      label: 'Dependencies',
      click: () => createDependenciesWindow(),
    },
    {
      label: 'Health window',
      click: () => createHealthWindow(),
    },
    {
      label: 'Close',
      accelerator: 'CmdOrCtrl+W',
      click: () => mainState.mainWindow?.close(),
    },
  ];
}

function buildHelpMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'About',
      click: () => {
        const mw = mainState.mainWindow;
        if (!mw) return;
        dialog.showMessageBox(mw, {
          type: 'info',
          title: 'About Clara Coder',
          message: 'Clara Coder v1.0.0',
          detail: 'An AI chat application with speech synthesis and recognition.',
        });
      },
    },
    {
      label: 'Documentation',
      click: () => openExternalUrl(DOCUMENTATION_URL),
    },
  ];
}

function buildWindowMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  if (process.platform === 'darwin') {
    return [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }];
  }
  return [{ role: 'minimize' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'close' }];
}

/**
 * Native application menu: Alt fallback on Windows/Linux and keyboard accelerators.
 * Titlebar File/Help use themed in-renderer dropdowns instead of Menu.popup.
 */
export function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: buildFileMenuTemplate() },
    { label: 'Window', submenu: buildWindowMenuTemplate() },
    { label: 'Help', submenu: buildHelpMenuTemplate() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Opens the docs URL from the themed Help menu (renderer IPC). */
export function openDocumentation(): void {
  openExternalUrl(DOCUMENTATION_URL);
}
