import { dialog, Menu, shell } from 'electron';
import type Electron from 'electron';
import { mainState } from '../state';
import { getRecentConversations } from './recent-conversations';
import { createSettingsWindow } from '../windows/settings-window';
import { createHealthWindow } from '../windows/health-window';

/**
 * Builds the application menu (File, Help). Open Recent aggregates conversation JSON files.
 */
export function buildMenu(): void {
  const recentConversations = getRecentConversations(5);
  const mw = mainState.mainWindow;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
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
                  click: () => mw?.webContents.send('open-conversation', conv.id),
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
          click: () => mw?.close(),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            if (!mw) return;
            dialog.showMessageBox(mw, {
              type: 'info',
              title: 'About Nemo Wrapper',
              message: 'Nemo Wrapper v1.0.0',
              detail: 'An AI chat application with speech synthesis and recognition.',
            });
          },
        },
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://github.com'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
