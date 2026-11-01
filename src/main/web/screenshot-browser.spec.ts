import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(), partition: vi.fn(), save: vi.fn(), config: vi.fn(), once: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { once: mocks.once },
  BrowserWindow: class { constructor(options: unknown) { return mocks.construct(options); } },
  session: { fromPartition: mocks.partition },
}));
vi.mock('../config/load-save', () => ({ loadConfigSync: mocks.config }));
vi.mock('./screenshot-assets', () => ({ saveCaptureAsset: mocks.save }));

import { captureWebpage, screenshotBrokerEnvironment, startScreenshotBroker, validateScreenshotRequest } from './screenshot-browser';
import { CaptureNetwork } from './screenshot-network';

const valid = { url: 'https://example.com/', width: 1280, height: 800, user_agent: 'Capture-Test/1.0' };
let isolated: any;
let win: any;

beforeEach(() => {
  mocks.construct.mockReset();
  mocks.partition.mockReset();
  mocks.config.mockReturnValue({ workspaceTools: { allowWebAccess: true } });
  mocks.save.mockResolvedValue('nemo-asset://capture/' + 'a'.repeat(32) + '.png');
  isolated = {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    on: vi.fn(), setProxy: vi.fn().mockResolvedValue(undefined),
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn() },
    closeAllConnections: vi.fn().mockResolvedValue(undefined), clearStorageData: vi.fn().mockResolvedValue(undefined),
  };
  win = {
    loadURL: vi.fn().mockResolvedValue(undefined), isDestroyed: vi.fn().mockReturnValue(false), destroy: vi.fn(),
    webContents: {
      setWindowOpenHandler: vi.fn(), setAudioMuted: vi.fn(), setWebRTCIPHandlingPolicy: vi.fn(), setUserAgent: vi.fn(), on: vi.fn(),
      getURL: vi.fn().mockReturnValue(valid.url),
      capturePage: vi.fn().mockResolvedValue({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), toPNG: () => Buffer.from('png') }),
    },
  };
  mocks.construct.mockReturnValue(win);
  mocks.partition.mockReturnValue(isolated);
});

describe('isolated screenshot Chromium', () => {
  it('uses a fresh sandbox with no preload, script, permissions or native networking', async () => {
    await expect(captureWebpage(valid)).resolves.toMatchObject({ width: 1280, height: 800, url: valid.url });
    expect(mocks.partition.mock.calls[0][0]).toMatch(/^screenshot-[a-f0-9]{32}$/);
    const options = mocks.construct.mock.calls[0][0];
    expect(options.show).toBe(false);
    expect(options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webviewTag: false });
    expect(options.webPreferences.preload).toBeUndefined();
    expect(isolated.setProxy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'fixed_servers', proxyBypassRules: '<-loopback>' }));
    expect(isolated.protocol.handle.mock.calls.map((call: any[]) => call[0])).toEqual(['http', 'https']);
    const permission = vi.fn();
    isolated.setPermissionRequestHandler.mock.calls[0][0](null, 'camera', permission);
    expect(permission).toHaveBeenCalledWith(false);
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    expect(win.destroy).toHaveBeenCalled();
    expect(isolated.clearStorageData).toHaveBeenCalled();
  });

  it('blocks scripts, iframe, file, websocket and private targets in the request gate', async () => {
    await captureWebpage(valid);
    const gate = isolated.webRequest.onBeforeRequest.mock.calls[0][0];
    for (const details of [
      { url: valid.url, resourceType: 'script' }, { url: valid.url, resourceType: 'subFrame' },
      { url: 'file:///secret', resourceType: 'image' }, { url: 'http://127.0.0.1/', resourceType: 'image' },
      { url: 'wss://example.com', resourceType: 'webSocket' },
    ]) {
      const callback = vi.fn();
      gate(details, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
  });

  it('returns a blocked response on network-policy failure, never falls back to Chromium', async () => {
    await captureWebpage(valid);
    const fetch = isolated.protocol.handle.mock.calls[0][1];
    const spy = vi.spyOn(CaptureNetwork.prototype, 'fetch').mockRejectedValue(new Error('blocked'));
    try {
      const response = await fetch(new Request(valid.url));
      expect(response.status).toBe(403);
    } finally { spy.mockRestore(); }
  });

  it('cleans up its isolated session even when navigation fails', async () => {
    win.loadURL.mockRejectedValue(new Error('failed'));
    await expect(captureWebpage(valid)).rejects.toThrow('failed');
    expect(win.destroy).toHaveBeenCalled();
    expect(isolated.protocol.unhandle).toHaveBeenCalledWith('https');
    expect(isolated.closeAllConnections).toHaveBeenCalled();
    expect(isolated.clearStorageData).toHaveBeenCalled();
  });

  it.each([{ width: 10000 }, { height: 0 }, { width: 600.5 }, { url: 'file:///private' }, { user_agent: 'person@example.com' }])('rejects invalid capture parameters %o', (patch) => {
    expect(() => validateScreenshotRequest({ ...valid, ...patch })).toThrow();
  });
});

describe('private screenshot broker', () => {
  afterAll(() => {
    const quit = mocks.once.mock.calls.find((call) => call[0] === 'will-quit');
    quit?.[1]();
  });

  it('rejects unauthenticated and browser-origin requests before running a capture', async () => {
    await startScreenshotBroker();
    const env = screenshotBrokerEnvironment();
    const denied = await fetch(env.CLARA_SCREENSHOT_URL, { method: 'POST', body: JSON.stringify(valid) });
    expect(denied.status).toBe(403);
    const origin = await fetch(env.CLARA_SCREENSHOT_URL, { method: 'POST', body: JSON.stringify(valid), headers: {
      Authorization: `Bearer ${env.CLARA_SCREENSHOT_TOKEN}`, Origin: 'https://example.com',
    } });
    expect(origin.status).toBe(403);
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it('respects the web access switch even for an authenticated sidecar', async () => {
    await startScreenshotBroker();
    mocks.config.mockReturnValue({ workspaceTools: { allowWebAccess: false } });
    const env = screenshotBrokerEnvironment();
    const denied = await fetch(env.CLARA_SCREENSHOT_URL, { method: 'POST', body: JSON.stringify(valid), headers: {
      Authorization: `Bearer ${env.CLARA_SCREENSHOT_TOKEN}`,
    } });
    expect(denied.status).toBe(429);
    expect(mocks.construct).not.toHaveBeenCalled();
  });
});
