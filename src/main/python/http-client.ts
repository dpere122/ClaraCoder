import { Agent, fetch as undiciFetch } from 'undici';

import { PYTHON_URL } from '../constants';

function joinPythonUrl(urlPath: string): string {
  const base = PYTHON_URL.endsWith('/') ? PYTHON_URL.slice(0, -1) : PYTHON_URL;
  const p = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  return `${base}${p}`;
}

/** Shared secret injected into the Python sidecar at spawn (Bearer auth). */
let pythonSidecarToken = '';

/** Set by `server.ts` before any control/SSE calls after token generation. */
export function setPythonSidecarToken(token: string): void {
  pythonSidecarToken = (token || '').trim();
}

export function getPythonSidecarToken(): string {
  return pythonSidecarToken;
}

function withSidecarAuth(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (pythonSidecarToken) {
    headers.set('Authorization', `Bearer ${pythonSidecarToken}`);
  }
  return { ...(init ?? {}), headers };
}

/**
 * Long-running SSE: disable undici inter-chunk `bodyTimeout` (default ~300s) so tool runs
 * and slow inference do not abort the stream (`UND_ERR_BODY_TIMEOUT`).
 */
export const pythonSseHttpAgent = new Agent({ bodyTimeout: 0 });

/** JSON/control calls to the local Python backend (same undici stack as SSE). */
const pythonControlHttpAgent = new Agent({
  bodyTimeout: 300_000,
  headersTimeout: 60_000,
});

/**
 * Editor LSP (hover / completion / didOpen) may wait on JDT ``initialize`` (up to 180s).
 * Must not share the 60s control agent — that surfaces as ``fetch failed`` when a Java
 * file is opened in Monaco while the sidecar handshake is still running.
 */
const pythonLspHttpAgent = new Agent({
  bodyTimeout: 300_000,
  headersTimeout: 210_000,
});

/**
 * Log ingest must not share the control agent: a wedged sidecar would otherwise queue
 * 60s header waits and starve ``/runtime/deps/list`` / health probes (``fetch failed``).
 */
const pythonLogIngestHttpAgent = new Agent({
  bodyTimeout: 2_000,
  headersTimeout: 2_000,
});

/** Long installs (deps / pip) — no body or headers timeout (Kokoro/pip can exceed minutes). */
const pythonLongHttpAgent = new Agent({
  bodyTimeout: 0,
  headersTimeout: 0,
});

/** Undici `fetch` vs `@types/node` `fetch` typings differ; callers use standard Response fields only. */
type WebResponse = Awaited<ReturnType<typeof undiciFetch>>;

export async function pythonControlFetch(urlPath: string, init?: RequestInit): Promise<WebResponse> {
  return undiciFetch(joinPythonUrl(urlPath), {
    ...withSidecarAuth(init),
    dispatcher: pythonControlHttpAgent,
  } as never);
}

/** Editor LSP JSON (may block on language-server initialize). */
export async function pythonLspFetch(urlPath: string, init?: RequestInit): Promise<WebResponse> {
  return undiciFetch(joinPythonUrl(urlPath), {
    ...withSidecarAuth(init),
    dispatcher: pythonLspHttpAgent,
  } as never);
}

/** Short-timeout POST used by Electron → Python log ingest. */
export async function pythonLogIngestFetch(urlPath: string, init?: RequestInit): Promise<WebResponse> {
  return undiciFetch(joinPythonUrl(urlPath), {
    ...withSidecarAuth(init),
    dispatcher: pythonLogIngestHttpAgent,
  } as never);
}

/** Long-running JSON POSTs (dependency install/reinstall). */
export async function pythonLongFetch(urlPath: string, init?: RequestInit): Promise<WebResponse> {
  return undiciFetch(joinPythonUrl(urlPath), {
    ...withSidecarAuth(init),
    dispatcher: pythonLongHttpAgent,
  } as never);
}

/** Long-lived SSE GET (dependency progress). */
export async function pythonSseGet(urlPath: string, init?: RequestInit): Promise<WebResponse> {
  return undiciFetch(joinPythonUrl(urlPath), {
    ...withSidecarAuth(init),
    dispatcher: pythonSseHttpAgent,
  } as never);
}

export async function pythonSsePost(
  urlPath: string,
  body: unknown,
  signal: AbortSignal,
): Promise<WebResponse> {
  return undiciFetch(joinPythonUrl(urlPath), {
    ...withSidecarAuth({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
    dispatcher: pythonSseHttpAgent,
  } as never);
}
