import { BrowserWindow, dialog, Menu, shell } from 'electron';
import type Electron from 'electron';
import { mainState } from '../state';
import { getRecentConversations } from './recent-conversations';
import { createSettingsWindow } from '../windows/settings-window';
import { createHealthWindow } from '../windows/health-window';

function buildFileMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  const recentConversations = getRecentConversations(5);
  return [
    {
      label: 'Open',
      accelerator: 'CmdOrCtrl+O',
      click: async () => {
        const mw = mainState.mainWindow;
        if (!mw) return;
        const result = await dialog.showOpenDialog(mw, {
          properties: ['openDirectory'],
        });
        if (!result.canceled && result.filePaths.length > 0) {
          mw.webContents.send('open-workspace', result.filePaths[0]);
        }
      },
    },
    {
      label: 'Open Recent',
      submenu:
        recentConversations.length > 0
          ? recentConversations.map((conv) => ({
              label: conv.title,
              click: () => {
                mainState.mainWindow?.webContents.send('open-conversation', conv.id);
              },
            }))
          : [{ label: 'No Recent Conversations', enabled: false }],
    },
    {
      label: 'Settings',
      accelerator: 'CmdOrCtrl+,',
      click: () => createSettingsWindow(),
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

/**
 * Main window uses frameless chrome; no native application menu bar.
 * (Open Recent stays fresh because each popup rebuilds from disk.)
 */
export function buildMenu(): void {
  Menu.setApplicationMenu(null);
}
