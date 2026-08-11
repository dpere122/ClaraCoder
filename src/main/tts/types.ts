export interface TtsRequestParams {
  text: string;
  voice: string;
  speed: number;
  /** OpenAI-compatible style / mood instructions (Qwen ``instruct``); ignored by Kokoro. */
  instructions?: string;
}

function ipv4Parts(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateIpv4(host: string): boolean {
  const parts = ipv4Parts(host);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** Expand a single IPv6 hextet pair like ``7f00:1`` into dotted IPv4 when possible. */
function hextetsToIpv4(a: string, b: string): string | null {
  const hi = parseInt(a, 16);
  const lo = parseInt(b, 16);
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi > 0xffff || lo > 0xffff) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIpv6(host: string): boolean {
  // Node may keep brackets on URL.hostname for IPv6 literals.
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (h === '::1') return true;

  // IPv4-mapped IPv6: ::ffff:x.x.x.x or ::ffff:7f00:1 (Node form)
  const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return isPrivateIpv4(dotted[1]);
  const hextetMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hextetMapped) {
    const v4 = hextetsToIpv4(hextetMapped[1], hextetMapped[2]);
    if (v4) return isPrivateIpv4(v4);
  }

  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]/i.test(h)) return true;
  return false;
}

/** True when URL hostname is loopback, RFC1918 private, link-local, or CGNAT. */
export function isPrivateHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (!host) return true;
  if (host === 'localhost') return true;
  if (host.includes(':') || host.startsWith('[')) return isPrivateIpv6(host);
  return isPrivateIpv4(host);
}
