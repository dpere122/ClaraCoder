import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  trusted: { sender: 'app' },
  assertTrusted: vi.fn(),
  loadConfig: vi.fn(),
  configure: vi.fn(),
  cleanup: vi.fn(),
  clear: vi.fn(),
  stats: vi.fn(),
  status: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler);
  } },
  BrowserWindow: { getAllWindows: () => [{
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: mocks.send },
  }] },
}));
vi.mock('../assert-trusted-renderer', () => ({ assertTrustedAppRenderer: mocks.assertTrusted }));
vi.mock('../../config/load-save', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../../web/screenshot-assets', () => ({
  configureCaptureRetention: mocks.configure,
  runCaptureMaintenance: mocks.cleanup,
  clearCaptureAssets: mocks.clear,
  getCaptureStorageStats: mocks.stats,
  getCaptureAssetStatus: mocks.status,
}));

import { registerScreenshotRetentionIpc } from './screenshot-retention';
import { createAppServicesApi } from '../../../preload/apis/app-services-api';
import type { PreloadIpc } from '../../../preload/preload-ipc';

const stats = { bytes: 1024, imageCount: 3, reducedCount: 1, maxBytes: 104857600, maxImages: 200 };
const policy = { downscaleAfterDays: 7, retentionDays: 30, maxWidth: 1280, maxStorageMiB: 100, maxImages: 200 };
const assetUrl = `nemo-asset://capture/${'a'.repeat(32)}.png`;
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(mocks.trusted, ...args);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  mocks.assertTrusted.mockImplementation((event: unknown) => {
    if (event !== mocks.trusted) throw new Error('Untrusted renderer');
  });
  mocks.loadConfig.mockResolvedValue({ workspaceTools: { screenshotRetention: policy } });
  mocks.stats.mockResolvedValue(stats);
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue({ state: 'available' });
  registerScreenshotRetentionIpc();
});

describe('screenshot retention IPC', () => {
  it.each(['screenshot-storage-stats', 'screenshot-cleanup', 'screenshot-clear', 'screenshot-asset-status'])(
    'rejects untrusted callers before any storage access: %s', async (channel) => {
      await expect(mocks.handlers.get(channel)!({}, assetUrl)).rejects.toThrow('Untrusted renderer');
      expect(mocks.loadConfig).not.toHaveBeenCalled();
      expect(mocks.configure).not.toHaveBeenCalled();
      expect(mocks.cleanup).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
      expect(mocks.stats).not.toHaveBeenCalled();
      expect(mocks.status).not.toHaveBeenCalled();
    },
  );

  it('reads current policy for every stats request without invoking cleanup', async () => {
    expect(await invoke('screenshot-storage-stats')).toEqual({ ok: true, stats });
    expect(mocks.configure).toHaveBeenLastCalledWith(policy);
    const updated = { ...policy, maxImages: 500 };
    mocks.loadConfig.mockResolvedValueOnce({ workspaceTools: { screenshotRetention: updated } });
    await invoke('screenshot-storage-stats');
    expect(mocks.configure).toHaveBeenLastCalledWith(updated);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(['screenshot-cleanup', 'screenshot-clear'])(
    'configures policy, runs action without path arguments and notifies renderers: %s', async (channel) => {
      expect(await invoke(channel, 'C:\\untrusted-path')).toEqual({ ok: true, stats });
      const action = channel === 'screenshot-cleanup' ? mocks.cleanup : mocks.clear;
      expect(action).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.configure.mock.invocationCallOrder[0]).toBeLessThan(action.mock.invocationCallOrder[0]);
      expect(action.mock.invocationCallOrder[0]).toBeLessThan(mocks.stats.mock.invocationCallOrder[0]);
      expect(mocks.send).toHaveBeenCalledWith('screenshot-assets-changed');
    },
  );

  it.each(['screenshot-storage-stats', 'screenshot-cleanup', 'screenshot-clear'])(
    'reports visible structured errors: %s', async (channel) => {
      mocks.loadConfig.mockRejectedValueOnce(new Error('Storage unavailable'));
      expect(await invoke(channel)).toEqual({ ok: false, error: 'Storage unavailable' });
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it('does not notify when maintenance fails', async () => {
    mocks.cleanup.mockRejectedValueOnce(new Error('Cleanup failed'));
    expect(await invoke('screenshot-cleanup')).toEqual({ ok: false, error: 'Cleanup failed' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('returns backend status for a capture URL', async () => {
    const status = { state: 'expired', reason: 'age', retentionDays: 30 };
    mocks.status.mockResolvedValueOnce(status);
    expect(await invoke('screenshot-asset-status', assetUrl)).toEqual(status);
    expect(mocks.status).toHaveBeenCalledWith(assetUrl);
  });

  it.each([undefined, {}, '/tmp/image.png', 'C:\\private\\image.png', 'file:///private/image.png',
    'https://example.com/image.png', 'nemo-asset://capture/../../private.png', `${assetUrl}?path=x`])(
    'never forwards paths or malformed asset URLs: %s', async (raw) => {
      expect(await invoke('screenshot-asset-status', raw)).toEqual({ state: 'missing' });
      expect(mocks.status).not.toHaveBeenCalled();
      expect(mocks.loadConfig).not.toHaveBeenCalled();
    },
  );

  it('returns a safe missing status on backend errors', async () => {
    mocks.status.mockRejectedValueOnce(new Error('private storage details'));
    expect(await invoke('screenshot-asset-status', assetUrl)).toEqual({ state: 'missing' });
  });
});

describe('screenshot retention preload bridge', () => {
  function bridge() {
    const ipc = {
      invoke: vi.fn().mockResolvedValue({ ok: true, stats }),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } satisfies PreloadIpc;
    return { ipc, api: createAppServicesApi(ipc) };
  }

  it.each([
    ['getScreenshotStorageStats', 'screenshot-storage-stats'],
    ['runScreenshotCleanup', 'screenshot-cleanup'],
    ['clearScreenshots', 'screenshot-clear'],
  ] as const)('maps %s to a path-free IPC invocation', async (method, channel) => {
    const { ipc, api } = bridge();
    expect(await api[method]()).toEqual({ ok: true, stats });
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith(channel);
  });

  it('passes only the opaque URL for status lookups', async () => {
    const { ipc, api } = bridge();
    ipc.invoke.mockResolvedValueOnce({ state: 'missing' });
    expect(await api.getScreenshotAssetStatus(assetUrl)).toEqual({ state: 'missing' });
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('screenshot-asset-status', assetUrl);
  });

  it('subscribes without leaking IPC event data and removes the exact listener', () => {
    const { ipc, api } = bridge();
    const callback = vi.fn();
    const unsubscribe = api.onScreenshotAssetsChanged(callback);
    expect(ipc.on).toHaveBeenCalledWith('screenshot-assets-changed', expect.any(Function));
    const listener = ipc.on.mock.calls[0][1];
    listener({}, 'ignored payload');
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledExactlyOnceWith('screenshot-assets-changed', listener);
  });
});
