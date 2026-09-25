/**
 * Theme broadcasts to every app window. Kept separate from the IPC handlers so window
 * lifecycle code (e.g. the settings window closing) can clear a live preview without pulling
 * the whole handler graph (dialogs, config persistence) into its import tree.
 */
import type { BrowserWindow } from 'electron';
import { mainState } from '../../state';
import type { ClaraThemeDocument } from '../../../shared/theme/theme-document';
import { THEME_IPC } from '../../../shared/theme/theme-ipc';

export function allAppWindows(): BrowserWindow[] {
  return [mainState.mainWindow, mainState.settingsWindow, mainState.healthWindow, mainState.dependenciesWindow].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  );
}

export function broadcastToAppWindows(channel: string, payload: unknown): void {
  for (const win of allAppWindows()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Window can be torn down between the check and send.
    }
  }
}

/** Paint `theme` in every window without persisting; `null` returns to the saved theme. */
export function broadcastThemePreview(theme: ClaraThemeDocument | null): void {
  broadcastToAppWindows(THEME_IPC.previewChanged, theme);
}
