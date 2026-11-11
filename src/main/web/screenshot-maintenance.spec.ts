import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(), configure: vi.fn(), maintain: vi.fn(), broadcast: vi.fn(),
}));
vi.mock('../config/load-save', () => ({ loadConfigSync: mocks.config }));
vi.mock('./screenshot-assets', () => ({
  configureCaptureRetention: mocks.configure,
  runCaptureMaintenance: mocks.maintain,
}));
vi.mock('../ipc/handlers/theme-broadcast', () => ({ broadcastToAppWindows: mocks.broadcast }));

import { DEFAULT_SCREENSHOT_RETENTION } from '../../shared/screenshot-retention';
import { applyScreenshotRetention, startScreenshotMaintenance, stopScreenshotMaintenance } from './screenshot-maintenance';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.config.mockReturnValue({ workspaceTools: { screenshotRetention: DEFAULT_SCREENSHOT_RETENTION } });
  mocks.maintain.mockResolvedValue(undefined);
});
afterEach(() => {
  stopScreenshotMaintenance();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('screenshot maintenance lifecycle', () => {
  it('runs at startup and daily, using the latest saved policy', async () => {
    startScreenshotMaintenance();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.configure).toHaveBeenCalledWith(DEFAULT_SCREENSHOT_RETENTION);
    expect(mocks.maintain).toHaveBeenCalledTimes(1);
    expect(mocks.broadcast).toHaveBeenCalledWith('screenshot-assets-changed', undefined);
    const changed = { ...DEFAULT_SCREENSHOT_RETENTION, retentionDays: 14 };
    mocks.config.mockReturnValue({ workspaceTools: { screenshotRetention: changed } });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(mocks.configure).toHaveBeenLastCalledWith(changed);
    expect(mocks.maintain).toHaveBeenCalledTimes(2);
  });

  it('does not install duplicate timers and cancels maintenance on shutdown', async () => {
    startScreenshotMaintenance();
    startScreenshotMaintenance();
    expect(vi.getTimerCount()).toBe(1);
    expect(mocks.maintain).toHaveBeenCalledTimes(1);
    stopScreenshotMaintenance();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(mocks.maintain).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('immediately applies saved changes but skips unrelated config saves', async () => {
    startScreenshotMaintenance();
    applyScreenshotRetention({ ...DEFAULT_SCREENSHOT_RETENTION });
    expect(mocks.maintain).toHaveBeenCalledTimes(1);
    const changed = { ...DEFAULT_SCREENSHOT_RETENTION, maxWidth: 960 };
    applyScreenshotRetention(changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.configure).toHaveBeenLastCalledWith(changed);
    expect(mocks.maintain).toHaveBeenCalledTimes(2);
  });

  it('normalizes malformed settings before applying them', () => {
    applyScreenshotRetention(undefined);
    expect(mocks.configure).toHaveBeenCalledWith(DEFAULT_SCREENSHOT_RETENTION);
  });

  it('handles job failures without leaking paths and retries on the next interval', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.maintain.mockRejectedValueOnce(new Error('secret-path/metadata.json'));
    startScreenshotMaintenance();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith('[screenshots] Screenshot retention cleanup failed.');
    expect(mocks.broadcast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(mocks.maintain).toHaveBeenCalledTimes(2);
    expect(mocks.broadcast).toHaveBeenCalledOnce();
  });

  it('survives a config load error and retries the next day', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.config.mockImplementationOnce(() => { throw new Error('invalid config'); });
    startScreenshotMaintenance();
    expect(mocks.maintain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(mocks.maintain).toHaveBeenCalledOnce();
  });
});
