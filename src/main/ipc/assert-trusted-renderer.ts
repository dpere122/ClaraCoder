import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { mainState } from '../state';

/** True when the IPC sender is the primary app window (not settings/health satellites). */
export function isTrustedMainRenderer(sender: WebContents): boolean {
  const mw = mainState.mainWindow;
  return !!mw && !mw.isDestroyed() && sender === mw.webContents;
}

function isOwnedAppWindow(sender: WebContents, win: BrowserWindow | null): boolean {
  return !!win && !win.isDestroyed() && sender === win.webContents;
}

/** Main, settings, health, or dependencies window — trusted app-owned UI surfaces. */
export function isTrustedAppRenderer(sender: WebContents): boolean {
  if (isTrustedMainRenderer(sender)) {
    return true;
  }
  return (
    isOwnedAppWindow(sender, mainState.settingsWindow) ||
    isOwnedAppWindow(sender, mainState.healthWindow) ||
    isOwnedAppWindow(sender, mainState.dependenciesWindow)
  );
}

export function assertTrustedMainRenderer(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isTrustedMainRenderer(event.sender)) {
    throw new Error('Untrusted IPC sender');
  }
}

export function assertTrustedAppRenderer(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isTrustedAppRenderer(event.sender)) {
    throw new Error('Untrusted IPC sender');
  }
}

/**
 * Same as {@link assertTrustedMainRenderer}; named for `ipcMain.handle` callers that
 * catch and map to `{ ok: false, error: 'Untrusted IPC sender' }`.
 */
export function assertTrustedMainRendererOrThrow(event: IpcMainEvent | IpcMainInvokeEvent): void {
  assertTrustedMainRenderer(event);
}
