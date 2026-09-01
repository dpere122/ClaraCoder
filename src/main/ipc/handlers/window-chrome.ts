import { BrowserWindow, ipcMain } from 'electron';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';
import { openDocumentation } from '../../menu/application-menu';

/**
 * Frameless window controls (minimize / maximize / close).
 * Settings / Dependencies / Health titlebar controls are rendered in-app so they follow UI themes.
 */
export function registerWindowChromeIpc(): void {
  ipcMain.on('open-documentation', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    openDocumentation();
  });

  ipcMain.on('window-minimize', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window-toggle-maximize', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    if (w.isMaximized()) {
      w.unmaximize();
    } else {
      w.maximize();
    }
  });

  ipcMain.on('window-close', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle('window-is-maximized', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return false;
    }
    const w = BrowserWindow.fromWebContents(event.sender);
    return w?.isMaximized() ?? false;
  });
}
