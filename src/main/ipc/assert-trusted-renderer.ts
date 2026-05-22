import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { mainState } from '../state';

/** True when the IPC sender is the primary app window (not settings/health satellites). */
export function isTrustedMainRenderer(sender: WebContents): boolean {
  const mw = mainState.mainWindow;
  return !!mw && !mw.isDestroyed() && sender === mw.webContents;
}

/** Main or settings window — allowed for folder pickers and other user-initiated app UI. */
export function isTrustedAppRenderer(sender: WebContents): boolean {
  if (isTrustedMainRenderer(sender)) {
    return true;
  }
  const sw = mainState.settingsWindow;
  return !!sw && !sw.isDestroyed() && sender === sw.webContents;
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
