import { BrowserWindow, dialog, Menu, shell } from 'electron';
import type Electron from 'electron';
import { mainState } from '../state';
import { createSettingsWindow } from '../windows/settings-window';
import { createHealthWindow } from '../windows/health-window';
import { createDependenciesWindow } from '../windows/dependencies-window';

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
      click: () => shell.openExternal('https://github.com'),
    },
  ];
}

export function popupFileMenu(win: BrowserWindow, x: number, y: number): void {
  const menu = Menu.buildFromTemplate(buildFileMenuTemplate());
  menu.popup({ window: win, x, y });
}

export function popupHelpMenu(win: BrowserWindow, x: number, y: number): void {
  const menu = Menu.buildFromTemplate(buildHelpMenuTemplate());
  menu.popup({ window: win, x, y });
}

function buildWindowMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  if (process.platform === 'darwin') {
    return [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }];
  }
  return [{ role: 'minimize' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'close' }];
}

/**
 * Frameless main window uses in-titlebar File/Help buttons; native menu is a fallback
 * (Alt on Windows/Linux) and supplies Window actions when custom chrome is unavailable.
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
