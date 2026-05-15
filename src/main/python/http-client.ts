import { Agent, fetch as undiciFetch } from 'undici';

import { PYTHON_URL } from '../constants';

function joinPythonUrl(urlPath: string): string {
  const base = PYTHON_URL.endsWith('/') ? PYTHON_URL.slice(0, -1) : PYTHON_URL;
  const p = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  return `${base}${p}`;
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

/** Undici `fetch` vs `@types/node` `fetch` typings differ; callers use standard Response fields only. */
type WebResponse = Awaited<ReturnType<typeof undiciFetch>>;

export async function pythonControlFetch(urlPath: string, init?: RequestInit): Promise<WebResponse> {
  return undiciFetch(joinPythonUrl(urlPath), {
    ...(init ?? {}),
    dispatcher: pythonControlHttpAgent,
  } as never);
}

export async function pythonSsePost(
  urlPath: string,
  body: unknown,
  signal: AbortSignal,
): Promise<WebResponse> {
  return undiciFetch(joinPythonUrl(urlPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    dispatcher: pythonSseHttpAgent,
  } as never);
}
