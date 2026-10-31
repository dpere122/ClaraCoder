/**
 * Dev-only: when this page runs in a plain browser tab (no preload), installs `window.electronAPI`
 * backed by the main-process browser bridge (`npm run dev:bridge`), so the full app can be driven
 * from a test browser. The API object is built from the same preload factories as Electron's.
 *
 * The `<port>.<token>` pair arrives once in the `claraBridge` query parameter, is removed from the
 * address bar immediately, and is kept in sessionStorage so reloads of this tab stay connected.
 *
 * A tab on `#/settings`, `#/dependencies`, `#/health` or `#/updater` acts as that satellite window: loading it
 * opens the real window first. Opening a satellite from the app logs the URL of a tab acting as it.
 */
import {
  BROWSER_BRIDGE_INSTANCE_HEADER,
  BROWSER_BRIDGE_QUERY_PARAM,
  BROWSER_BRIDGE_WINDOW_HEADER,
  bridgeParse,
  bridgeStringify,
  browserBridgeSettingsTabForHash,
  browserBridgeUrl,
  browserBridgeWindowForHash,
  formatBrowserBridgeParam,
  parseBrowserBridgeParam,
  type BridgeBase64,
  type BrowserBridgeEndpoint,
  type BrowserBridgeEvent,
  type BrowserBridgeInvokeResponse,
  type BrowserBridgeWindow,
} from '@shared/dev/browser-bridge-protocol';
import { createAppServicesApi } from '../../../../../preload/apis/app-services-api';
import { createChatApi } from '../../../../../preload/apis/chat-api';
import { createConversationApi } from '../../../../../preload/apis/conversation-api';
import { createDependenciesApi } from '../../../../../preload/apis/dependencies-api';
import { createLspHealthApi } from '../../../../../preload/apis/lsp-health-api';
import { createModelManagerApi } from '../../../../../preload/apis/model-manager-api';
import { createThemeApi } from '../../../../../preload/apis/theme-api';
import { createUpdaterApi } from '../../../../../preload/apis/updater-api';
import { createWorkspaceApi } from '../../../../../preload/apis/workspace-api';
import type { PreloadIpc } from '../../../../../preload/preload-ipc';

const STORAGE_KEY = 'clara.browserBridge';
const RECONNECT_MIN_MS = 500;
/** Short enough that a tab is back soon after an electronmon restart. */
const RECONNECT_MAX_MS = 5_000;

/** Renderer `send`s that open a satellite window; the bridge also opens a tab acting as it. */
const OPEN_WINDOW_CHANNELS: Readonly<Record<string, BrowserBridgeWindow>> = {
  'open-settings-window': 'settings',
  'open-dependencies-window': 'dependencies',
  'open-health-window': 'health',
  'open-updater-window': 'updater',
};

type Listener = (event: unknown, ...args: unknown[]) => void;

const BROWSER_BASE64: BridgeBase64 = {
  encode(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  },
  decode(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },
};

/** Installs the bridged `electronAPI` if this tab was opened with (or already holds) a bridge token. */
export function installBrowserBridgeFromLocation(): boolean {
  const endpoint = takeEndpoint();
  if (!endpoint) {
    return false;
  }
  const hash = window.location.hash;
  const appWindow = browserBridgeWindowForHash(hash);
  const ipc = new BrowserBridgeIpc(endpoint, appWindow, browserBridgeSettingsTabForHash(hash));
  const api = {
    ...createChatApi(ipc),
    ...createWorkspaceApi(ipc),
    ...createConversationApi(ipc),
    ...createAppServicesApi(ipc),
    ...createModelManagerApi(ipc),
    ...createLspHealthApi(ipc),
    ...createDependenciesApi(ipc),
    ...createThemeApi(ipc),
    ...createUpdaterApi(ipc),
  };
  window.electronAPI = api as unknown as NonNullable<Window['electronAPI']>;
  console.info(
    `[BrowserBridge] Connected to the Electron main process on 127.0.0.1:${endpoint.port} as the ${appWindow} window`,
  );
  return true;
}

function takeEndpoint(): BrowserBridgeEndpoint | null {
  const url = new URL(window.location.href);
  const fromUrl = parseBrowserBridgeParam(url.searchParams.get(BROWSER_BRIDGE_QUERY_PARAM));
  if (url.searchParams.has(BROWSER_BRIDGE_QUERY_PARAM)) {
    url.searchParams.delete(BROWSER_BRIDGE_QUERY_PARAM);
    history.replaceState(history.state, '', url.toString());
  }
  if (fromUrl) {
    writeStoredParam(formatBrowserBridgeParam(fromUrl));
    return fromUrl;
  }
  return parseBrowserBridgeParam(readStoredParam());
}

function readStoredParam(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredParam(value: string | null): void {
  try {
    if (value) {
      sessionStorage.setItem(STORAGE_KEY, value);
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage blocked: the bridge still works until this tab reloads.
  }
}

/** Dev-only banner over the app; the tab is unusable until reopened with a fresh token. */
function showBridgeNotice(message: string): void {
  if (document.getElementById('clara-bridge-notice')) {
    return;
  }
  const notice = document.createElement('div');
  notice.id = 'clara-bridge-notice';
  notice.setAttribute('role', 'alert');
  notice.textContent = message;
  Object.assign(notice.style, {
    position: 'fixed',
    inset: '0 0 auto 0',
    zIndex: '2147483647',
    padding: '10px 16px',
    font: '13px/1.4 system-ui, sans-serif',
    color: '#fff',
    background: '#b42318',
    textAlign: 'center',
  });
  document.body.append(notice);
}

/** `ipcRenderer` stand-in: invoke/send over HTTP, push events over one NDJSON stream. */
class BrowserBridgeIpc implements PreloadIpc {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  /** Resolves once a satellite's real window is open; every request waits for it. */
  private readonly windowReady: Promise<void>;
  /** Electron delivers `send`s in order; chain them so the HTTP requests keep that order. */
  private sendQueue: Promise<void> = Promise.resolve();
  private streaming = false;
  private revoked = false;
  /** The main-process launch this page loaded against; set from the first response. */
  private instanceId: string | null = null;

  constructor(
    private readonly endpoint: BrowserBridgeEndpoint,
    private readonly appWindow: BrowserBridgeWindow,
    settingsTab: string | undefined,
  ) {
    this.baseUrl = `http://127.0.0.1:${endpoint.port}`;
    this.headers = { Authorization: `Bearer ${endpoint.token}`, [BROWSER_BRIDGE_WINDOW_HEADER]: appWindow };
    this.windowReady = appWindow === 'main' ? Promise.resolve() : this.openWindow(settingsTab);
  }

  private async openWindow(tab: string | undefined): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/window`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: bridgeStringify({ tab }, BROWSER_BASE64),
      });
      this.checkInstance(res);
      if (!res.ok) {
        console.warn(`[BrowserBridge] Could not open the ${this.appWindow} window: ${await this.httpError(res)}`);
      }
    } catch (err) {
      console.warn(`[BrowserBridge] Could not open the ${this.appWindow} window:`, err);
    }
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const res = await this.post('/invoke', channel, args);
    if (!res.ok) {
      throw new Error(`Error invoking remote method '${channel}': ${await this.httpError(res)}`);
    }
    const body = bridgeParse(await res.text(), BROWSER_BASE64) as BrowserBridgeInvokeResponse;
    if (!body.ok) {
      throw new Error(`Error invoking remote method '${channel}': ${body.error}`);
    }
    return body.result;
  }

  send(channel: string, ...args: unknown[]): void {
    const opens = OPEN_WINDOW_CHANNELS[channel];
    if (opens) {
      // Logged, not `window.open`ed: embedded test browsers load popups in the current tab,
      // which would turn this tab into the satellite.
      const tab = opens === 'settings' && typeof args[0] === 'string' ? args[0] : undefined;
      console.info(
        `[BrowserBridge] Opening the ${opens} window; drive it from a new tab: ` +
          browserBridgeUrl(window.location.origin, this.endpoint, opens, tab),
      );
    }
    this.sendQueue = this.sendQueue
      .then(async () => {
        const res = await this.post('/send', channel, args);
        if (!res.ok) {
          console.warn(`[BrowserBridge] send '${channel}' failed: ${await this.httpError(res)}`);
        }
      })
      .catch((err: unknown) => console.warn(`[BrowserBridge] send '${channel}' failed:`, err));
  }

  on(channel: string, listener: Listener): this {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    if (!this.streaming) {
      this.streaming = true;
      void this.streamEvents();
    }
    return this;
  }

  removeListener(channel: string, listener: Listener): this {
    this.listeners.get(channel)?.delete(listener);
    return this;
  }

  private async post(path: string, channel: string, args: unknown[]): Promise<Response> {
    await this.windowReady;
    if (this.revoked) {
      throw new Error('Browser bridge token was rejected; reopen the URL printed by npm run dev:bridge');
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: bridgeStringify({ channel, args }, BROWSER_BASE64),
    });
    this.checkInstance(res);
    return res;
  }

  /**
   * A new instance id means the main process restarted (same token, see `browser-bridge.ts` in
   * main). Its windows start with fresh renderers, so this tab reloads too; a satellite tab then
   * reopens its window. Returns true when a reload is under way.
   */
  private checkInstance(res: Response): boolean {
    const instanceId = res.headers.get(BROWSER_BRIDGE_INSTANCE_HEADER);
    if (!instanceId || instanceId === this.instanceId) {
      return false;
    }
    if (this.instanceId === null) {
      this.instanceId = instanceId;
      return false;
    }
    console.info('[BrowserBridge] The app restarted; reloading this tab.');
    window.location.reload();
    return true;
  }

  private async httpError(res: Response): Promise<string> {
    if (res.status === 401) {
      this.revoke();
    } else if (res.status === 503) {
      this.windowClosed();
    }
    try {
      const body = JSON.parse(await res.text()) as { error?: string };
      return body.error ?? `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  }

  /** The token was rotated (its file deleted): stop retrying and forget the stale one. */
  private revoke(): void {
    if (this.revoked) {
      return;
    }
    this.revoked = true;
    writeStoredParam(null);
    const message =
      'Browser bridge disconnected: the bridge token changed. Reopen the URL printed by npm run dev:bridge.';
    console.error(`[BrowserBridge] ${message}`);
    showBridgeNotice(message);
  }

  /** The window this tab acts as is gone (closed in the app, or never opened). */
  private windowClosed(): void {
    const message = `Browser bridge: the ${this.appWindow} window is not open. Reload this tab to reopen it.`;
    console.error(`[BrowserBridge] ${message}`);
    showBridgeNotice(message);
  }

  private async streamEvents(): Promise<void> {
    await this.windowReady;
    let delay = RECONNECT_MIN_MS;
    while (!this.revoked) {
      try {
        const res = await fetch(`${this.baseUrl}/events`, {
          headers: this.headers,
          cache: 'no-store',
        });
        if (this.checkInstance(res)) {
          return;
        }
        if (res.status === 401) {
          this.revoke();
          return;
        }
        if (res.status === 503) {
          // Only satellites get this: their window closed, and only a reload reopens it.
          this.windowClosed();
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        delay = RECONNECT_MIN_MS;
        await this.readLines(res.body);
      } catch (err) {
        console.warn('[BrowserBridge] Event stream dropped; reconnecting.', err);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  private async readLines(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          this.dispatch(bridgeParse(line, BROWSER_BASE64) as BrowserBridgeEvent);
        }
        newline = buffered.indexOf('\n');
      }
    }
  }

  private dispatch({ channel, args }: BrowserBridgeEvent): void {
    const listeners = this.listeners.get(channel);
    if (!listeners) {
      return;
    }
    const event = { sender: null, senderId: 0 };
    for (const listener of [...listeners]) {
      try {
        listener(event, ...args);
      } catch (err) {
        console.error(`[BrowserBridge] '${channel}' listener threw:`, err);
      }
    }
  }
}
