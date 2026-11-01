import { BrowserWindow, ipcMain } from 'electron';
import type { ScreenshotAssetStatus, ScreenshotStorageStats } from '../../../shared/screenshot-retention';
import { loadConfig } from '../../config/load-save';
import {
  clearCaptureAssets,
  configureCaptureRetention,
  getCaptureAssetStatus,
  getCaptureStorageStats,
  runCaptureMaintenance,
} from '../../web/screenshot-assets';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

export type ScreenshotStorageResult =
  | { ok: true; stats: ScreenshotStorageStats }
  | { ok: false; error: string };

function notifyScreenshotAssetsChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('screenshot-assets-changed');
    }
  }
}

async function storageAction(action?: () => Promise<void>): Promise<ScreenshotStorageResult> {
  try {
    const config = await loadConfig();
    configureCaptureRetention(config.workspaceTools?.screenshotRetention);
    if (action) {
      await action();
      notifyScreenshotAssetsChanged();
    }
    return { ok: true, stats: await getCaptureStorageStats() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Storage actions accept no paths; status accepts only an opaque capture URL. */
export function registerScreenshotRetentionIpc(): void {
  ipcMain.handle('screenshot-storage-stats', async (event): Promise<ScreenshotStorageResult> => {
    assertTrustedAppRenderer(event);
    return storageAction();
  });
  ipcMain.handle('screenshot-cleanup', async (event): Promise<ScreenshotStorageResult> => {
    assertTrustedAppRenderer(event);
    return storageAction(runCaptureMaintenance);
  });
  ipcMain.handle('screenshot-clear', async (event): Promise<ScreenshotStorageResult> => {
    assertTrustedAppRenderer(event);
    return storageAction(clearCaptureAssets);
  });
  ipcMain.handle('screenshot-asset-status', async (event, raw: unknown): Promise<ScreenshotAssetStatus> => {
    assertTrustedAppRenderer(event);
    if (typeof raw !== 'string' || !/^nemo-asset:\/\/capture\/[a-f0-9]{32}\.png$/.test(raw)) {
      return { state: 'missing' };
    }
    try {
      const config = await loadConfig();
      configureCaptureRetention(config.workspaceTools?.screenshotRetention);
      return await getCaptureAssetStatus(raw);
    } catch {
      return { state: 'missing' };
    }
  });
}
