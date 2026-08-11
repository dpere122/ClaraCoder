import { dialog, Menu, shell } from 'electron';
import type Electron from 'electron';
import { mainState } from '../state';
import { createSettingsWindow } from '../windows/settings-window';
import { createHealthWindow } from '../windows/health-window';
import { createDependenciesWindow } from '../windows/dependencies-window';

const DOCUMENTATION_URL = 'https://github.com';

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
      click: () => void shell.openExternal(DOCUMENTATION_URL),
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
  void shell.openExternal(DOCUMENTATION_URL);
}
