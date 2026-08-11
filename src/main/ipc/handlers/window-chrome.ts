import { BrowserWindow, ipcMain } from 'electron';
import { openDocumentation } from '../../menu/application-menu';

/**
 * Frameless window controls (minimize / maximize / close).
 * File / Help titlebar menus are rendered in-app so they follow UI themes.
 */
export function registerWindowChromeIpc(): void {
  ipcMain.on('open-documentation', () => {
    openDocumentation();
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
