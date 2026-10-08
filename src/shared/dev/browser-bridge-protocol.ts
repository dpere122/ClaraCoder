/**
 * Wire format for the dev-only browser bridge (`CLARA_BROWSER_BRIDGE=1`): a plain browser tab on
 * the Angular dev server drives the same `ipcMain` handlers as the Electron window, over loopback HTTP.
 *
 * JSON alone would drop what Electron's structured clone keeps (binary buffers, `undefined` args,
 * dates), so values are tagged on the way out and restored on the way in.
 */

/** Query parameter carrying `<port>.<token>` into the browser tab (stripped from the URL on load). */
export const BROWSER_BRIDGE_QUERY_PARAM = 'claraBridge';

export interface BrowserBridgeEndpoint {
  port: number;
  token: string;
}

/** Body of `POST /invoke` and `POST /send`. */
export interface BrowserBridgeCall {
  channel: string;
  args: unknown[];
}

/** Body of a `POST /invoke` response; handler errors come back as `ok: false`, like a rejected invoke. */
export type BrowserBridgeInvokeResponse = { ok: true; result: unknown } | { ok: false; error: string };

/** One line of the `GET /events` NDJSON stream: a main-to-renderer `webContents.send`. */
export interface BrowserBridgeEvent {
  channel: string;
  args: unknown[];
}

/** Base64 for bytes; Node and the browser each supply their own (Buffer vs btoa/atob). */
export interface BridgeBase64 {
  encode(bytes: Uint8Array): string;
  decode(base64: string): Uint8Array;
}

const TAG = '__claraBridge';

type Tagged =
  | { [TAG]: 'undefined' }
  | { [TAG]: 'bytes'; data: string }
  | { [TAG]: 'arraybuffer'; data: string }
  | { [TAG]: 'date'; time: number }
  | { [TAG]: 'error'; name: string; message: string };

export function formatBrowserBridgeParam(endpoint: BrowserBridgeEndpoint): string {
  return `${endpoint.port}.${endpoint.token}`;
}

export function parseBrowserBridgeParam(raw: string | null | undefined): BrowserBridgeEndpoint | null {
  const match = /^(\d{1,5})\.([A-Za-z0-9_-]{32,})$/.exec(raw?.trim() ?? '');
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? { port, token: match[2] } : null;
}

export function bridgeStringify(value: unknown, base64: BridgeBase64): string {
  return JSON.stringify(value, function (this: unknown, key: string, encoded: unknown): unknown {
    // `toJSON` (Date, Buffer) has already run on `encoded`; the holder still has the original.
    const raw = (this as Record<string, unknown>)[key];
    if (raw === undefined) {
      return { [TAG]: 'undefined' } satisfies Tagged;
    }
    if (raw instanceof Uint8Array) {
      return { [TAG]: 'bytes', data: base64.encode(raw) } satisfies Tagged;
    }
    if (raw instanceof ArrayBuffer) {
      return { [TAG]: 'arraybuffer', data: base64.encode(new Uint8Array(raw)) } satisfies Tagged;
    }
    if (raw instanceof Date) {
      return { [TAG]: 'date', time: raw.getTime() } satisfies Tagged;
    }
    if (raw instanceof Error) {
      return { [TAG]: 'error', name: raw.name, message: raw.message } satisfies Tagged;
    }
    return encoded;
  });
}

export function bridgeParse(text: string, base64: BridgeBase64): unknown {
  return JSON.parse(text, (_key: string, value: unknown): unknown => {
    if (!value || typeof value !== 'object' || !(TAG in value)) {
      return value;
    }
    const tagged = value as Tagged;
    switch (tagged[TAG]) {
      case 'undefined':
        return undefined;
      case 'bytes':
        return base64.decode(tagged.data);
      case 'arraybuffer': {
        const bytes = base64.decode(tagged.data);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      case 'date':
        return new Date(tagged.time);
      case 'error': {
        const err = new Error(tagged.message);
        err.name = tagged.name;
        return err;
      }
      default:
        return value;
    }
  });
}
