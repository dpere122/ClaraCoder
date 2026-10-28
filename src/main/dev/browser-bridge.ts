/**
 * Dev-only browser bridge: lets a plain browser tab on the Angular dev server (e.g. an embedded
 * test browser) drive the app through the same `ipcMain` handlers as the Electron window.
 *
 * Off unless `CLARA_BROWSER_BRIDGE=1`, the app is unpackaged, and `DEV_SERVER_URL` is set
 * (`npm run dev:bridge`). Every request must:
 *  - reach the loopback listener (127.0.0.1 only) with a loopback `Host` (blocks DNS rebinding);
 *  - come from the dev server origin (CORS is granted to that origin alone);
 *  - carry the bearer token (32 random bytes, compared in constant time).
 *
 * The token is kept in `browser-bridge-token` under the dev app-data dir and reused across
 * launches, so open tabs survive electronmon restarts: each launch has its own instance id
 * (`X-Clara-Bridge-Instance` on `/events`), and a tab that sees it change reloads itself, as the
 * Electron windows do. Delete the file to rotate the token; old tabs then get a 401.
 *
 * A tab acts as the app window its route belongs to (`#/settings`, `#/dependencies`, `#/health`,
 * anything else the main window), named by the `X-Clara-Bridge-Window` header. Calls run as that
 * window: handlers see its `webContents` as `event.sender`, so trust checks pass and the tab has
 * that window's full privileges. A satellite tab first opens the real window (`POST /window`) and
 * receives only that window's `webContents.send` pushes. That is the point (end-to-end testing)
 * and why the token never leaves this machine except in the URLs printed to the dev log and
 * `browser-bridge.json` under the dev app-data dir.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import {
  BROWSER_BRIDGE_INSTANCE_HEADER,
  BROWSER_BRIDGE_WINDOW_HEADER,
  BROWSER_BRIDGE_WINDOWS,
  bridgeParse,
  bridgeStringify,
  browserBridgeUrl,
  isBrowserBridgeToken,
  parseBrowserBridgeWindow,
  type BridgeBase64,
  type BrowserBridgeCall,
  type BrowserBridgeInvokeResponse,
  type BrowserBridgeOpenWindow,
  type BrowserBridgeWindow,
} from '../../shared/dev/browser-bridge-protocol';
import { DEV_SERVER_URL } from '../constants';
import { envClara } from '../env-clara';
import { getAppDataDir } from '../paths';
import { mainState } from '../state';
import { createDependenciesWindow } from '../windows/dependencies-window';
import { createHealthWindow } from '../windows/health-window';
import { createSettingsWindow, parseSettingsWindowTab } from '../windows/settings-window';

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
type SendListener = (event: IpcMainEvent, ...args: any[]) => void;

/** Generous enough for pasted images / recorded audio, small enough to refuse a runaway body. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;
/**
 * Fixed so an open tab reconnects to the restarted app (electronmon) instead of retrying a dead
 * random port. `CLARA_BROWSER_BRIDGE_PORT` overrides it.
 */
const DEFAULT_PORT = 4210;

const NODE_BASE64: BridgeBase64 = {
  encode: (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
  decode: (base64) => new Uint8Array(Buffer.from(base64, 'base64')),
};

const invokeHandlers = new Map<string, InvokeHandler>();
const sendListeners = new Map<string, Set<SendListener>>();
/** Open `GET /events` streams, each with the window its tab acts as. */
const eventClients = new Map<ServerResponse, BrowserBridgeWindow>();
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
  const token = loadOrCreateToken(join(getAppDataDir(), 'browser-bridge-token'));
  const expectedToken = Buffer.from(token);
  const instanceId = randomBytes(8).toString('hex');
  const portOverride = Number(envClara('BROWSER_BRIDGE_PORT') ?? 0) || 0;

  mirrorWindowSends();
  // Satellites open from the app as well as from tabs, and the main window can be recreated
  // (macOS activate); `mainState` is set right after construction.
  app.on('browser-window-created', () => setImmediate(mirrorWindowSends));

  const listener = createServer((req, res) => {
    handleRequest(req, res, devServer.origin, expectedToken, instanceId).catch((err: unknown) => {
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

  const windows = Object.fromEntries(
    BROWSER_BRIDGE_WINDOWS.map((win) => [win, browserBridgeUrl(devServer.toString(), { port, token }, win)]),
  ) as Record<BrowserBridgeWindow, string>;
  const openUrl = windows.main;
  const infoPath = join(getAppDataDir(), 'browser-bridge.json');
  try {
    writeFileSync(infoPath, JSON.stringify({ port, token, url: openUrl, windows, pid: process.pid }, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    console.warn('[BrowserBridge] Could not write', infoPath, err);
  }
  app.once('will-quit', () => {
    for (const client of eventClients.keys()) {
      client.end();
    }
    eventClients.clear();
    listener.close();
    server = null;
    rmSync(infoPath, { force: true });
  });
  console.log(`[BrowserBridge] Listening on 127.0.0.1:${port}. Open in a browser: ${openUrl}`);
}

function loadOrCreateToken(tokenPath: string): string {
  try {
    const saved = readFileSync(tokenPath, 'utf8').trim();
    if (isBrowserBridgeToken(saved)) {
      return saved;
    }
  } catch {
    // First launch, or unreadable: mint a new one.
  }
  const token = randomBytes(32).toString('base64url');
  try {
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch (err) {
    console.warn('[BrowserBridge] Could not save the token; tabs will need the new URL after a restart.', err);
  }
  return token;
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

function appWindow(win: BrowserBridgeWindow): BrowserWindow | null {
  switch (win) {
    case 'main':
      return mainState.mainWindow;
    case 'settings':
      return mainState.settingsWindow;
    case 'dependencies':
      return mainState.dependenciesWindow;
    case 'health':
      return mainState.healthWindow;
  }
}

function windowWebContents(win: BrowserBridgeWindow): WebContents | null {
  const bw = appWindow(win);
  return bw && !bw.isDestroyed() ? bw.webContents : null;
}

/** Opens (or focuses) a satellite window the way its titlebar menu entry does. */
function openAppWindow(win: BrowserBridgeWindow, tab: string | undefined): void {
  switch (win) {
    case 'main':
      break;
    case 'settings':
      createSettingsWindow(parseSettingsWindowTab(tab));
      break;
    case 'dependencies':
      createDependenciesWindow();
      break;
    case 'health':
      createHealthWindow();
      break;
  }
  mirrorWindowSends();
}

/** Forwards each app window's `webContents.send` pushes to the tabs acting as that window. */
function mirrorWindowSends(): void {
  for (const win of BROWSER_BRIDGE_WINDOWS) {
    const wc = windowWebContents(win);
    if (!wc || mirroredSenders.has(wc)) {
      continue;
    }
    mirroredSenders.add(wc);
    const send = wc.send.bind(wc);
    wc.send = ((channel: string, ...args: unknown[]) => {
      send(channel, ...args);
      broadcast(win, channel, args);
    }) as typeof wc.send;
    if (win !== 'main') {
      // Ends the tabs' streams; their reconnect gets a 503 and tells the user the window closed.
      wc.once('destroyed', () => endEventStreams(win));
    }
  }
}

function endEventStreams(win: BrowserBridgeWindow): void {
  for (const [client, clientWin] of eventClients) {
    if (clientWin === win) {
      eventClients.delete(client);
      client.end();
    }
  }
}

function broadcast(win: BrowserBridgeWindow, channel: string, args: unknown[]): void {
  const clients = [...eventClients].filter(([, clientWin]) => clientWin === win).map(([client]) => client);
  if (clients.length === 0) {
    return;
  }
  let line: string;
  try {
    line = `${bridgeStringify({ channel, args }, NODE_BASE64)}\n`;
  } catch (err) {
    console.warn(`[BrowserBridge] Dropped '${channel}' event (not serializable):`, err);
    return;
  }
  for (const client of clients) {
    client.write(line);
  }
}

/** An IPC event that impersonates an app window; `reply` goes to the tabs acting as it only. */
function bridgeEvent(wc: WebContents, win: BrowserBridgeWindow): IpcMainEvent & IpcMainInvokeEvent {
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
    reply: (channel: string, ...args: unknown[]) => broadcast(win, channel, args),
  } as unknown as IpcMainEvent & IpcMainInvokeEvent;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigin: string,
  expectedToken: Buffer,
  instanceId: string,
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
  res.setHeader('Access-Control-Expose-Headers', BROWSER_BRIDGE_INSTANCE_HEADER);
  res.setHeader(BROWSER_BRIDGE_INSTANCE_HEADER, instanceId);
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': `Authorization, Content-Type, ${BROWSER_BRIDGE_WINDOW_HEADER}`,
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }
  if (!hasValidToken(req, expectedToken)) {
    sendJson(res, 401, { ok: false, error: 'Invalid bridge token' });
    return;
  }

  const header = req.headers[BROWSER_BRIDGE_WINDOW_HEADER.toLowerCase()];
  const win = parseBrowserBridgeWindow(Array.isArray(header) ? header[0] : header);
  if (!win) {
    sendJson(res, 400, { ok: false, error: `Unknown ${BROWSER_BRIDGE_WINDOW_HEADER}` });
    return;
  }
  const notOpen = `The ${win} window is not open`;

  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (req.method === 'GET' && path === '/events') {
    // The main tab's stream outlives a main-window restart; a satellite's ends with its window.
    if (win !== 'main' && !windowWebContents(win)) {
      sendJson(res, 503, { ok: false, error: notOpen });
      return;
    }
    openEventStream(req, res, win);
    return;
  }
  if (req.method === 'POST' && path === '/window') {
    const open = parseOpenWindow(await readBody(req));
    if (!open) {
      sendJson(res, 400, { ok: false, error: 'Expected { tab? }' });
      return;
    }
    openAppWindow(win, open.tab);
    if (windowWebContents(win)) {
      sendJson(res, 200, { ok: true, result: null });
    } else {
      sendJson(res, 503, { ok: false, error: notOpen });
    }
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
  const wc = windowWebContents(win);
  if (!wc) {
    sendJson(res, 503, { ok: false, error: notOpen });
    return;
  }
  mirrorWindowSends();

  if (path === '/send') {
    const listeners = sendListeners.get(call.channel);
    if (!listeners?.size) {
      sendJson(res, 404, { ok: false, error: `No ipcMain.on listener for '${call.channel}'` });
      return;
    }
    const event = bridgeEvent(wc, win);
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
    response = { ok: true, result: await handler(bridgeEvent(wc, win), ...call.args) };
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

function openEventStream(req: IncomingMessage, res: ServerResponse, win: BrowserBridgeWindow): void {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  // Blank lines are keepalives; the client skips them.
  res.write('\n');
  eventClients.set(res, win);
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

function parseOpenWindow(body: string): BrowserBridgeOpenWindow | null {
  let parsed: unknown;
  try {
    parsed = body ? bridgeParse(body, NODE_BASE64) : {};
  } catch {
    return null;
  }
  const open = parsed as Partial<BrowserBridgeOpenWindow> | null;
  if (!open || (open.tab !== undefined && typeof open.tab !== 'string')) {
    return null;
  }
  return { tab: open.tab };
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
