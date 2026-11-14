import { app, BrowserWindow, ipcMain } from 'electron';
import { assertTrustedAppRenderer, isTrustedMainRenderer } from '../assert-trusted-renderer';
import { openDocumentation } from '../../menu/application-menu';
import {
  answerMainWindowCloseConfirm,
  APP_CLOSE_CONFIRM_ANSWER_CHANNEL,
} from '../../windows/main-window-close-guard';

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

  // Answer to the "an agent is still running" dialog a held close of the main window raised.
  ipcMain.on(APP_CLOSE_CONFIRM_ANSWER_CHANNEL, (event, proceed: unknown) => {
    if (!isTrustedMainRenderer(event.sender)) {
      return;
    }
    answerMainWindowCloseConfirm(proceed === true);
  });

  ipcMain.on('app-quit', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    app.quit();
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
