import { BrowserWindow, ipcMain } from 'electron';
import { popupFileMenu, popupHelpMenu } from '../../menu/application-menu';

/**
 * Frameless window controls and in-window File / Help menus (native Menu.popup).
 */
export function registerWindowChromeIpc(): void {
  ipcMain.handle('popup-file-menu', (event, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    popupFileMenu(win, Math.round(x), Math.round(y));
  });

  ipcMain.handle('popup-help-menu', (event, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    popupHelpMenu(win, Math.round(x), Math.round(y));
  });

  ipcMain.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window-toggle-maximize', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    if (w.isMaximized()) {
      w.unmaximize();
    } else {
      w.maximize();
    }
  });

  ipcMain.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle('window-is-maximized', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    return w?.isMaximized() ?? false;
  });
}
