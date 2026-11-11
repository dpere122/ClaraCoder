import { normalizeScreenshotRetention } from '../../shared/screenshot-retention';
import { loadConfigSync } from '../config/load-save';
import { broadcastToAppWindows } from '../ipc/handlers/theme-broadcast';
import { configureCaptureRetention, runCaptureMaintenance } from './screenshot-assets';

const DAY_MS = 24 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | undefined;
let policyKey = '';

function cleanUp(): void {
  void runCaptureMaintenance().then(() => {
    broadcastToAppWindows('screenshot-assets-changed', undefined);
  }).catch(() => {
    // Do not log filesystem paths or metadata. A failed job retries on the next
    // scheduled run, capture, or explicit cleanup from Settings.
    console.error('[screenshots] Screenshot retention cleanup failed.');
  });
}

/** Apply a saved policy immediately, without making Settings wait for image IO. */
export function applyScreenshotRetention(settings: unknown): void {
  const policy = normalizeScreenshotRetention(settings);
  const key = JSON.stringify(policy);
  if (key === policyKey) return;
  configureCaptureRetention(policy);
  policyKey = key;
  cleanUp();
}

/** Startup and daily maintenance are owned by Electron, not an OS scheduled task. */
export function startScreenshotMaintenance(): void {
  if (timer) return;
  const refresh = (): void => {
    try {
      const settings = loadConfigSync().workspaceTools.screenshotRetention;
      const policy = normalizeScreenshotRetention(settings);
      configureCaptureRetention(policy);
      policyKey = JSON.stringify(policy);
      cleanUp();
    } catch {
      console.error('[screenshots] Could not load screenshot retention settings.');
    }
  };
  refresh();
  timer = setInterval(refresh, DAY_MS);
  timer.unref();
}

export function stopScreenshotMaintenance(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  policyKey = '';
}
