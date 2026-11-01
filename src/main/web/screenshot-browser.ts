import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app, BrowserWindow, session } from 'electron';
import { loadConfigSync } from '../config/load-save';
import { saveCaptureAsset } from './screenshot-assets';
import { CaptureNetwork, captureUrl, captureUserAgent } from './screenshot-network';

export interface ScreenshotRequest {
  url: string;
  width: number;
  height: number;
  user_agent: string;
}

export function validateScreenshotRequest(value: unknown): ScreenshotRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid screenshot request.');
  const input = value as Record<string, unknown>;
  const width = input.width;
  const height = input.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      (width as number) < 320 || (width as number) > 1920 ||
      (height as number) < 240 || (height as number) > 1080) {
    throw new Error('Screenshot viewport must be 320–1920 by 240–1080 pixels.');
  }
  return {
    url: captureUrl(input.url as string).href,
    width: width as number,
    height: height as number,
    user_agent: captureUserAgent(input.user_agent),
  };
}

/** Static, isolated Chromium renderer. Remote content NEVER enters an app/preload window. */
export async function captureWebpage(input: ScreenshotRequest): Promise<{
  image_url: string; url: string; width: number; height: number;
}> {
  const request = validateScreenshotRequest(input);
  const isolated = session.fromPartition(`screenshot-${randomBytes(16).toString('hex')}`, { cache: false });
  const network = new CaptureNetwork(request.user_agent);
  let window: BrowserWindow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Own the rejecting proxy socket: never assume a well-known localhost port is unused.
  const denyProxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
  denyProxy.on('connect', (_request, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      denyProxy.once('error', reject);
      denyProxy.listen(0, '127.0.0.1', () => resolve());
    });
    const proxyPort = (denyProxy.address() as AddressInfo).port;
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.on('will-download', (event) => event.preventDefault());
    // The handlers below own ALL http(s) loads. Native network fallback, localhost's
    // implicit proxy bypass and direct connections are deliberately unavailable.
    await isolated.setProxy({
      mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${proxyPort};https=127.0.0.1:${proxyPort}`,
      proxyBypassRules: '<-loopback>',
    });
    const fetch = async (incoming: Request): Promise<Response> => {
      try { return await network.fetch(incoming.url); }
      catch { return new Response('Blocked by screenshot network policy.', { status: 403 }); }
    };
    isolated.protocol.handle('http', fetch);
    isolated.protocol.handle('https', fetch);
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const allowed = ['mainFrame', 'image', 'stylesheet', 'font'].includes(details.resourceType);
      try { captureUrl(details.url); callback({ cancel: !allowed }); }
      catch { callback({ cancel: true }); }
    });
    window = new BrowserWindow({
      show: false,
      width: request.width,
      height: request.height,
      useContentSize: true,
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        javascript: false,
        webviewTag: false,
        plugins: false,
        navigateOnDragDrop: false,
        backgroundThrottling: false,
        offscreen: true,
        safeDialogs: true,
        disableDialogs: true,
      },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.setAudioMuted(true);
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setUserAgent(request.user_agent);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    const capture = async () => {
      await window!.loadURL(request.url);
      const url = captureUrl(contents.getURL()).href;
      // Bound settling time for image decoding and a painted frame (no script execution).
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (window!.isDestroyed()) throw new Error('Screenshot cancelled.');
      const image = await contents.capturePage({ x: 0, y: 0, width: request.width, height: request.height });
      if (image.isEmpty()) throw new Error('Chromium returned an empty screenshot.');
      const size = image.getSize();
      const image_url = await saveCaptureAsset(image.toPNG());
      return { image_url, url, width: size.width, height: size.height };
    };
    return await Promise.race([
      capture(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Screenshot timed out (30 seconds).')), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    network.close();
    denyProxy.closeAllConnections();
    denyProxy.close();
    if (window && !window.isDestroyed()) window.destroy();
    isolated.webRequest.onBeforeRequest(null);
    isolated.protocol.unhandle('http');
    isolated.protocol.unhandle('https');
    await isolated.closeAllConnections();
    await isolated.clearStorageData();
  }
}

let broker: ReturnType<typeof createServer> | undefined;
let starting: Promise<void> | undefined;
let token = '';
let endpoint = '';
let busy = false;

export function screenshotBrokerEnvironment(): Record<string, string> {
  return { CLARA_SCREENSHOT_URL: endpoint, CLARA_SCREENSHOT_TOKEN: token };
}

function reply(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function handleCapture(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(request.headers.authorization ?? '');
  if (request.headers.origin || request.headers.host !== new URL(endpoint).host ||
      provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    reply(response, 403, { error: 'Forbidden' });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/capture') {
    reply(response, 404, { error: 'Not found' });
    return;
  }
  if (busy || !loadConfigSync().workspaceTools.allowWebAccess) {
    reply(response, 429, { error: busy ? 'Another screenshot is in progress.' : 'Web access is disabled.' });
    return;
  }
  busy = true;
  try {
    let text = '';
    for await (const chunk of request) {
      text += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(text) > 8192) throw new Error('Screenshot request is too large.');
    }
    const input = validateScreenshotRequest(JSON.parse(text));
    const result = await captureWebpage(input);
    reply(response, 200, result);
  } catch (error) {
    // Do not echo remote HTML, query strings, credentials or server-provided errors.
    reply(response, 400, { error: error instanceof Error && error.message.startsWith('Screenshot')
      ? error.message : 'Screenshot failed or was blocked by the public-network policy.' });
  } finally { busy = false; }
}

/** Private authenticated callback for the managed Python sidecar, not a renderer IPC API. */
export async function startScreenshotBroker(): Promise<void> {
  if (endpoint) return;
  if (starting) return starting;
  starting = (async () => {
    token = randomBytes(32).toString('hex');
    broker = createServer((request, response) => {
      void handleCapture(request, response).catch(() => reply(response, 500, { error: 'Screenshot unavailable.' }));
    });
    broker.requestTimeout = 10_000;
    broker.headersTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      broker!.once('error', reject);
      broker!.listen(0, '127.0.0.1', () => resolve());
    });
    endpoint = `http://127.0.0.1:${(broker.address() as AddressInfo).port}/capture`;
    app.once('will-quit', () => { broker?.close(); broker?.closeAllConnections(); });
  })().finally(() => { starting = undefined; });
  return starting;
}
