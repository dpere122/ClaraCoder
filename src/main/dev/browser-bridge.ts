/**
 * Dev-only browser bridge: lets a plain browser tab on the Angular dev server (e.g. an embedded
 * test browser) drive the app through the same `ipcMain` handlers as the Electron window.
 *
 * Off unless `CLARA_BROWSER_BRIDGE=1`, the app is unpackaged, and `DEV_SERVER_URL` is set
 * (`npm run dev:bridge`). Every request must:
 *  - reach the loopback listener (127.0.0.1 only) with a loopback `Host` (blocks DNS rebinding);
 *  - come from the dev server origin (CORS is granted to that origin alone);
 *  - carry the per-launch bearer token (32 random bytes, compared in constant time).
 *
 * Calls run as the main window: handlers see its `webContents` as `event.sender`, so trust checks
 * pass and the browser tab has the main window's full privileges. That is the point (end-to-end
 * testing) and why the token never leaves this machine except in the URL printed to the dev log
 * and `browser-bridge.json` under the dev app-data dir.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { rmSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  BROWSER_BRIDGE_QUERY_PARAM,
  bridgeParse,
  bridgeStringify,
  formatBrowserBridgeParam,
  type BridgeBase64,
  type BrowserBridgeCall,
  type BrowserBridgeInvokeResponse,
} from '../../shared/dev/browser-bridge-protocol';
import { DEV_SERVER_URL } from '../constants';
import { envClara } from '../env-clara';
import { getAppDataDir } from '../paths';
import { mainState } from '../state';

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
type SendListener = (event: IpcMainEvent, ...args: any[]) => void;

/** Generous enough for pasted images / recorded audio, small enough to refuse a runaway body. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;
/**
 * Fixed so an open tab reaches the restarted app (electronmon) and gets a clear token rejection
 * instead of retrying a dead random port. `CLARA_BROWSER_BRIDGE_PORT` overrides it.
 */
const DEFAULT_PORT = 4210;

const NODE_BASE64: BridgeBase64 = {
  encode: (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
  decode: (base64) => new Uint8Array(Buffer.from(base64, 'base64')),
};

const invokeHandlers = new Map<string, InvokeHandler>();
const sendListeners = new Map<string, Set<SendListener>>();
const eventClients = new Set<ServerResponse>();
const mirroredSenders = new WeakSet<WebContents>();
let server: Server | null = null;

export function isBrowserBridgeEnabled(): boolean {
  return !app.isPackaged && !!DEV_SERVER_URL && envClara('BROWSER_BRIDGE') === '1';
}

/**
 * Records `ipcMain.handle` / `ipcMain.on` registrations so the bridge can dispatch to them
 * (Electron offers no public lookup). Must run before {@link registerAllIpc}.
 */
export function captureIpcForBrowserBridge(): void {
  if (!isBrowserBridgeEnabled()) {
    return;
  }
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: InvokeHandler) => {
    invokeHandlers.set(channel, listener);
    handle(channel, listener);
  }) as typeof ipcMain.handle;

  const removeHandler = ipcMain.removeHandler.bind(ipcMain);
  ipcMain.removeHandler = ((channel: string) => {
    invokeHandlers.delete(channel);
    removeHandler(channel);
  }) as typeof ipcMain.removeHandler;

  const on = ipcMain.on.bind(ipcMain);
  ipcMain.on = ((channel: string, listener: SendListener) => {
    let listeners = sendListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      sendListeners.set(channel, listeners);
    }
    listeners.add(listener);
    return on(channel, listener);
  }) as typeof ipcMain.on;

  const removeListener = ipcMain.removeListener.bind(ipcMain);
  ipcMain.removeListener = ipcMain.off = ((channel: string, listener: SendListener) => {
    sendListeners.get(channel)?.delete(listener);
    return removeListener(channel, listener);
  }) as typeof ipcMain.removeListener;
}

/** Starts the loopback listener and prints the URL to open. No-op unless enabled. */
export async function startBrowserBridge(): Promise<void> {
  if (!isBrowserBridgeEnabled() || server || !DEV_SERVER_URL) {
    return;
  }
  const devServer = new URL(DEV_SERVER_URL);
  const token = randomBytes(32).toString('base64url');
  const expectedToken = Buffer.from(token);
  const portOverride = Number(envClara('BROWSER_BRIDGE_PORT') ?? 0) || 0;

  mirrorMainWindowSends();
  // The main window can be recreated (macOS activate); `mainState` is set right after creation.
  app.on('browser-window-created', () => setImmediate(mirrorMainWindowSends));

  const listener = createServer((req, res) => {
    handleRequest(req, res, devServer.origin, expectedToken).catch((err: unknown) => {
      console.error('[BrowserBridge] Request failed:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'Bridge error' });
      } else {
        res.end();
      }
    });
  });
  server = listener;
  try {
    await listen(listener, portOverride || DEFAULT_PORT);
  } catch (err) {
    if (portOverride || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw err;
    }
    console.warn(
      `[BrowserBridge] Port ${DEFAULT_PORT} is in use; using a random port. ` +
        'Open tabs will not notice app restarts until reopened with the new URL.',
    );
    await listen(listener, 0);
  }
  const { port } = listener.address() as AddressInfo;

  devServer.searchParams.set(BROWSER_BRIDGE_QUERY_PARAM, formatBrowserBridgeParam({ port, token }));
  devServer.hash = '/';
  const openUrl = devServer.toString();
  const infoPath = join(getAppDataDir(), 'browser-bridge.json');
  try {
    writeFileSync(infoPath, JSON.stringify({ port, token, url: openUrl, pid: process.pid }, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    console.warn('[BrowserBridge] Could not write', infoPath, err);
  }
  app.once('will-quit', () => {
    for (const client of eventClients) {
      client.end();
    }
    eventClients.clear();
    listener.close();
    server = null;
    rmSync(infoPath, { force: true });
  });
  console.log(`[BrowserBridge] Listening on 127.0.0.1:${port}. Open in a browser: ${openUrl}`);
}

function listen(listener: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    listener.once('error', onError);
    listener.listen(port, '127.0.0.1', () => {
      listener.off('error', onError);
      resolve();
    });
  });
}

function mainWebContents(): WebContents | null {
  const win = mainState.mainWindow;
  return win && !win.isDestroyed() ? win.webContents : null;
}

/** Forwards main-window `webContents.send` pushes to connected browser tabs as well. */
function mirrorMainWindowSends(): void {
  const wc = mainWebContents();
  if (!wc || mirroredSenders.has(wc)) {
    return;
  }
  mirroredSenders.add(wc);
  const send = wc.send.bind(wc);
  wc.send = ((channel: string, ...args: unknown[]) => {
    send(channel, ...args);
    broadcast(channel, args);
  }) as typeof wc.send;
}

function broadcast(channel: string, args: unknown[]): void {
  if (eventClients.size === 0) {
    return;
  }
  let line: string;
  try {
    line = `${bridgeStringify({ channel, args }, NODE_BASE64)}\n`;
  } catch (err) {
    console.warn(`[BrowserBridge] Dropped '${channel}' event (not serializable):`, err);
    return;
  }
  for (const client of eventClients) {
    client.write(line);
  }
}

/** An IPC event that impersonates the main window; `reply` goes to the bridge tab only. */
function bridgeEvent(wc: WebContents): IpcMainEvent & IpcMainInvokeEvent {
  return {
    type: 'frame',
    sender: wc,
    senderFrame: wc.mainFrame,
    processId: wc.getProcessId(),
    frameId: wc.mainFrame.routingId,
    ports: [],
    returnValue: undefined,
    defaultPrevented: false,
    preventDefault: () => undefined,
    reply: (channel: string, ...args: unknown[]) => broadcast(channel, args),
  } as unknown as IpcMainEvent & IpcMainInvokeEvent;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigin: string,
  expectedToken: Buffer,
): Promise<void> {
  const port = (server?.address() as AddressInfo | null)?.port;
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    sendJson(res, 421, { ok: false, error: 'Unexpected Host' });
    return;
  }
  if (req.headers.origin !== allowedOrigin) {
    sendJson(res, 403, { ok: false, error: 'Origin not allowed' });
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }
  if (!hasValidToken(req, expectedToken)) {
    sendJson(res, 401, { ok: false, error: 'Invalid bridge token' });
    return;
  }

  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (req.method === 'GET' && path === '/events') {
    openEventStream(req, res);
    return;
  }
  if (req.method !== 'POST' || (path !== '/invoke' && path !== '/send')) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  const call = parseCall(await readBody(req));
  if (!call) {
    sendJson(res, 400, { ok: false, error: 'Expected { channel, args[] }' });
    return;
  }
  const wc = mainWebContents();
  if (!wc) {
    sendJson(res, 503, { ok: false, error: 'Main window is not open' });
    return;
  }
  mirrorMainWindowSends();

  if (path === '/send') {
    const listeners = sendListeners.get(call.channel);
    if (!listeners?.size) {
      sendJson(res, 404, { ok: false, error: `No ipcMain.on listener for '${call.channel}'` });
      return;
    }
    const event = bridgeEvent(wc);
    for (const listener of [...listeners]) {
      try {
        listener(event, ...call.args);
      } catch (err) {
        console.error(`[BrowserBridge] '${call.channel}' listener threw:`, err);
      }
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const handler = invokeHandlers.get(call.channel);
  if (!handler) {
    sendJson(res, 404, { ok: false, error: `No ipcMain.handle handler for '${call.channel}'` });
    return;
  }
  let response: BrowserBridgeInvokeResponse;
  try {
    response = { ok: true, result: await handler(bridgeEvent(wc), ...call.args) };
  } catch (err) {
    response = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  sendJson(res, 200, response);
}

function hasValidToken(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization ?? '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function openEventStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  // Blank lines are keepalives; the client skips them.
  res.write('\n');
  eventClients.add(res);
  const keepalive = setInterval(() => res.write('\n'), KEEPALIVE_MS);
  req.on('close', () => {
    clearInterval(keepalive);
    eventClients.delete(res);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCall(body: string): BrowserBridgeCall | null {
  let parsed: unknown;
  try {
    parsed = bridgeParse(body, NODE_BASE64);
  } catch {
    return null;
  }
  const call = parsed as Partial<BrowserBridgeCall> | null;
  if (!call || typeof call.channel !== 'string' || !call.channel || !Array.isArray(call.args)) {
    return null;
  }
  return { channel: call.channel, args: call.args };
}

function sendJson(res: ServerResponse, status: number, body: BrowserBridgeInvokeResponse): void {
  let text: string;
  try {
    text = bridgeStringify(body, NODE_BASE64);
  } catch (err) {
    status = 500;
    text = JSON.stringify({ ok: false, error: `Result not serializable: ${String(err)}` });
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}
