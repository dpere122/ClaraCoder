import { ipcMain } from 'electron';
import type { AppUpdateActionResult } from '../../../shared/app-updater';
import {
  cancelAppDownload,
  currentAppVersion,
  downloadAppRelease,
  getUpdateState,
  installAppUpdateNow,
  installAppUpdateOnQuit,
  listAppReleases,
  registerAppUpdaterQuitHooks,
} from '../../updater/app-updater';
import { closeUpdaterWindow, createUpdaterWindow } from '../../windows/updater-window';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

const UNTRUSTED: AppUpdateActionResult = { ok: false, error: 'Untrusted IPC sender' };

/** Updates window IPC. The renderer names a version; main resolves everything else itself. */
export function registerUpdaterIpc(): void {
  registerAppUpdaterQuitHooks();

  ipcMain.handle('app:get-version', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return '';
    }
    return currentAppVersion();
  });

  ipcMain.handle('updater:list-releases', async (event, force?: boolean) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false, currentVersion: '', releases: [], error: UNTRUSTED.error };
    }
    return listAppReleases(force === true);
  });

  ipcMain.handle('updater:get-state', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return null;
    }
    return getUpdateState();
  });

  ipcMain.handle('updater:download', async (event, version: unknown) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return UNTRUSTED;
    }
    if (typeof version !== 'string' || version.length > 64) {
      return { ok: false, error: 'Invalid version' };
    }
    return downloadAppRelease(version);
  });

  ipcMain.handle('updater:cancel', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return UNTRUSTED;
    }
    return cancelAppDownload();
  });

  ipcMain.handle('updater:install-now', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return UNTRUSTED;
    }
    return installAppUpdateNow();
  });

  ipcMain.handle('updater:install-on-quit', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return UNTRUSTED;
    }
    return installAppUpdateOnQuit();
  });

  ipcMain.on('open-updater-window', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    createUpdaterWindow();
  });

  ipcMain.on('close-updater-window', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    closeUpdaterWindow();
  });
}
