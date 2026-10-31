/**
 * HTTPS fetch for release assets that follows redirects one hop at a time and refuses any hop
 * that leaves GitHub's release hosts, so an asset can only ever come from the pinned repo's
 * release storage.
 */

/** The slice of `fetch` the updater uses (injectable for tests). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** github.com serves the release URL; the bytes come from GitHub's asset CDN. */
export const RELEASE_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const MAX_REDIRECTS = 5;

export function assertAllowedDownloadUrl(raw: string, hosts: ReadonlySet<string> = RELEASE_DOWNLOAD_HOSTS): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Refusing malformed download URL`);
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) {
    throw new Error(`Refusing non-HTTPS download URL (${u.protocol}//${u.host})`);
  }
  if (!hosts.has(u.hostname.toLowerCase())) {
    throw new Error(`Refusing download from untrusted host ${u.hostname}`);
  }
  return u;
}

/** GETs `url`, following up to {@link MAX_REDIRECTS} redirects, each checked against `hosts`. */
export async function fetchPinned(
  url: string,
  opts: { fetchImpl: FetchLike; userAgent: string; signal?: AbortSignal; hosts?: ReadonlySet<string> },
): Promise<Response> {
  let current = assertAllowedDownloadUrl(url, opts.hosts);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await opts.fetchImpl(current.href, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/octet-stream' },
      redirect: 'manual',
      signal: opts.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`Redirect without a Location header (HTTP ${res.status})`);
      current = assertAllowedDownloadUrl(new URL(location, current).href, opts.hosts);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Download failed (HTTP ${res.status})`);
    }
    return res;
  }
  throw new Error('Too many redirects');
}

/** Reads a response body as UTF-8, failing once it exceeds `maxBytes`. */
export async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
