import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const deniedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) deniedV4.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  deniedV6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicCaptureAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
}

/** Check decoded URLs too: a model must not leak an email in a query/path/header. */
export function hasCaptureEmail(text: string): boolean {
  for (let i = 0; i < 16; i++) {
    if (/[^\s/@]+@[^\s/@]+\.[a-z]{2,}/i.test(text)) return true;
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) return false;
      text = decoded;
    } catch { return false; }
  }
  // Fail closed on excessive nested encoding, rather than miss a concealed address.
  return true;
}

export function captureUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x20\x7f]/.test(raw)) {
    throw new Error('Invalid screenshot URL.');
  }
  let decoded = raw;
  for (let i = 0; i < 16; i++) {
    if (/[\x00-\x1f\x7f\\]/.test(decoded)) throw new Error('Invalid screenshot URL.');
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== '80' && url.port !== '443') || hasCaptureEmail(raw)) {
    throw new Error('Only public HTTP(S) URLs without credentials or email addresses are allowed.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicCaptureAddress(host)) throw new Error('Non-public screenshot address blocked.');
  url.hash = '';
  return url;
}

export function captureUserAgent(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 512 ||
      /[^\x20-\x7e]/.test(raw) || hasCaptureEmail(raw)) {
    throw new Error('Screenshot User-Agent must be printable ASCII and contain no email addresses.');
  }
  return raw.trim();
}

export type CaptureResolver = (host: string) => Promise<{ address: string; family: number }[]>;

/** Validate ALL DNS answers; connect to the checked IP, never resolve the host a second time. */
export async function resolveCaptureAddress(
  host: string,
  resolve: CaptureResolver = (name) => lookup(name, { all: true, verbatim: true }),
): Promise<string> {
  const literal = host.replace(/^\[|\]$/g, '');
  const answers = isIP(literal) ? [{ address: literal, family: isIP(literal) }] : await resolve(literal);
  if (!answers.length || answers.some((answer) => !isPublicCaptureAddress(answer.address))) {
    throw new Error('Non-public screenshot address blocked.');
  }
  return answers[0].address;
}

/** Per-capture limits shared by main-frame, CSS, fonts and image subrequests. */
export class CaptureNetwork {
  private requests = 0;
  private bytes = 0;
  private readonly active = new Set<ReturnType<typeof httpRequest>>();
  private closed = false;

  constructor(private readonly userAgent: string) {
    captureUserAgent(userAgent);
  }

  close(): void {
    this.closed = true;
    for (const request of this.active) request.destroy();
    this.active.clear();
  }

  async fetch(rawUrl: string): Promise<Response> {
    const url = captureUrl(rawUrl);
    if (this.closed || ++this.requests > 80) throw new Error('Screenshot request budget exceeded.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const address = await resolveCaptureAddress(host);
    if (this.closed) throw new Error('Screenshot cancelled.');
    return new Promise<Response>((resolve, reject) => {
      const makeRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
      // Native Chromium networking is disabled. This transport is the only outbound path.
      // Host/SNI retain the original hostname for virtual hosting and certificate validation.
      const request = makeRequest({
        hostname: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        servername: isIP(host) ? undefined : host,
        method: 'GET',
        path: url.pathname + url.search,
        headers: {
          Host: url.host,
          'User-Agent': this.userAgent,
          Accept: 'text/html,application/xhtml+xml,image/*,text/css,font/*;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
        },
        rejectUnauthorized: true,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          this.bytes += chunk.length;
          if (size > 8 * 1024 * 1024 || this.bytes > 32 * 1024 * 1024) {
            request.destroy(new Error('Screenshot download budget exceeded.'));
          } else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const status = response.statusCode ?? 502;
            const headers = new Headers({
              'Content-Type': response.headers['content-type'] ?? 'application/octet-stream',
              // Defense in depth: page scripts, workers, forms and nested frames cannot run.
              'Content-Security-Policy': "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'",
              'X-Content-Type-Options': 'nosniff',
            });
            if (response.headers.location && status >= 300 && status < 400) {
              headers.set('Location', captureUrl(new URL(response.headers.location, url).href).href);
            }
            // Never forward cookies, authentication, referer, Set-Cookie or Content-Disposition.
            const body = [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks));
            resolve(new Response(body, { status, headers }));
          } catch (error) { reject(error); }
        });
      });
      this.active.add(request);
      request.on('close', () => this.active.delete(request));
      request.on('error', reject);
      request.setTimeout(10_000, () => request.destroy(new Error('Screenshot network timeout.')));
      request.end();
    });
  }
}
